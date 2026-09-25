#!/usr/bin/env python3
"""
deploy.py — one command to publish everything Halloween

    python3 halloween/deploy.py            # summary, confirm, then do it all
    python3 halloween/deploy.py --check    # summary only, change nothing
    python3 halloween/deploy.py --yes      # no prompt (for a cron or an alias)

It reads the feeder sheet, validates, and then:

  1. writes events.json / venues.json / tags.json   (what the web app reads)
  2. rewrites the public Google Sheet
  3. commits those JSON files and pushes            (what makes the site live)

Errors stop everything before anything is written. Warnings are shown and
you decide — most of them are things you already know about, like a venue
that is deliberately vague.

Individual steps still exist if you want one without the other:
    python3 halloween/build-web.py
    python3 halloween/publish-sheets.py
"""

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

DATA_FILES = ["events.json", "venues.json", "tags.json"]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(*args, capture=True):
    return subprocess.run(["git", "-C", str(REPO), *args],
                          capture_output=capture, text=True)


def rule(title):
    print(f"\n\033[1m{title}\033[0m")


def main():
    ap = argparse.ArgumentParser(description="Publish the Halloween guide")
    ap.add_argument("--check", action="store_true",
                    help="summary only; write nothing, touch nothing")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation")
    ap.add_argument("--no-sheet", action="store_true",
                    help="skip the public Google Sheet")
    ap.add_argument("--no-push", action="store_true",
                    help="build and commit, but do not push")
    args = ap.parse_args()

    build = load("build_web", "build-web.py")
    publish = load("publish_sheets", "publish-sheets.py")

    # ── read and validate ────────────────────────────────────────────────
    cfg = build.load_config()
    if cfg.get("year"):
        build.FESTIVAL_YEAR = int(cfg["year"])
    try:
        rows = build.read_sheet(cfg["feeder_sheet"], cfg.get("feeder_tab"))
        mapping = build.map_columns(rows[0])
    except build.BuildError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    occurrences, errors, warnings = build.resolve(rows[1:], mapping)
    tag_list, suspects = build.discover_tags(occurrences)
    events = build.build_events(occurrences)

    days = sorted({e["date"] for e in events if e["date"] != "all-month"})
    names = {e["name"] for e in events}

    rule("FEEDER")
    print(f"  {len(occurrences)} occurrences · {len(names)} events · "
          f"{len(days)} days · {len(tag_list)} tags")
    if days:
        print(f"  {days[0]} → {days[-1]}")

    if errors:
        rule(f"ERRORS ({len(errors)}) — nothing will be written")
        for e in errors:
            print(f"  {e}")
        return 1

    if warnings or suspects:
        rule(f"WARNINGS ({len(warnings) + len(suspects)}) — shown, not blocking")
        for w in warnings:
            print(f"  {w}")
        for a, ca, b, cb, why in suspects:
            print(f"  possible tag typo: {a!r} ({ca}) vs {b!r} ({cb}) — {why}")

    # What the sheet would look like, without touching it.
    sheet_rows, _ = publish.build_rows(events)

    rule("WILL")
    print(f"  write {', '.join(DATA_FILES)}")
    if not args.no_sheet:
        print(f"  rewrite the public Sheet ({len(sheet_rows)} rows)")
    else:
        print("  skip the public Sheet (--no-sheet)")

    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if args.no_push:
        print(f"  commit on {branch}, no push (--no-push)")
    else:
        print(f"  commit + push {branch} → live site")

    if args.check:
        print("\ncheck only — nothing written.")
        return 0

    if not args.yes:
        try:
            if input("\nProceed? [y/N] ").strip().lower() not in ("y", "yes"):
                print("aborted.")
                return 1
        except EOFError:
            print("aborted (no tty; pass --yes).")
            return 1

    # ── write ────────────────────────────────────────────────────────────
    rule("WRITING")
    build.write_json(HERE / "events.json", events)
    build.write_json(HERE / "venues.json", build.build_venues(occurrences))
    build.write_json(HERE / "tags.json", tag_list)
    print(f"  ✓ {', '.join(DATA_FILES)}")

    if not args.no_sheet:
        try:
            written, links = publish.write_sheet(events)
        except Exception as e:
            print(f"  ✗ public Sheet failed: {e}", file=sys.stderr)
            print("    The JSON was written, so --no-sheet would still ship "
                  "the site.", file=sys.stderr)
            return 1
        print(f"  ✓ public Sheet ({len(written)} rows, {len(links)} links)")

    # ── ship ─────────────────────────────────────────────────────────────
    paths = [f"halloween/{f}" for f in DATA_FILES]
    git("add", *paths, capture=True)
    staged = git("diff", "--cached", "--name-only").stdout.split()
    if not staged:
        print("\nno data changes to commit — the site is already current.")
        return 0

    msg = (f"Refresh Halloween data: {len(occurrences)} occurrences, "
           f"{len(names)} events")
    c = git("commit", "-m", msg)
    if c.returncode:
        print(c.stdout + c.stderr, file=sys.stderr)
        return 1
    print(f"  ✓ committed ({len(staged)} file(s))")

    if args.no_push:
        print(f"\nnot pushed. When ready:  git push origin {branch}")
        return 0

    p = git("push", "origin", branch)
    if p.returncode:
        print(p.stdout + p.stderr, file=sys.stderr)
        print("  ✗ push failed — the commit is local; fix and push again",
              file=sys.stderr)
        return 1
    print("  ✓ pushed — the site will update in a minute or two")
    return 0


if __name__ == "__main__":
    sys.exit(main())
