#!/usr/bin/env python3
"""
build.py — Halloween tracker ingest

Reads the feeder sheet (Google Sheets, or a CSV export), resolves fill-down
inheritance, validates, and emits events.json / venues.json / tags.json for the
web app.  Writing the public output sheet is a separate step, added once the
service-account credentials exist.

Usage:
    python3 halloween/build.py --csv halloween/sample_feeder.csv --dry-run
    python3 halloween/build.py --csv path/to/export.csv
    python3 halloween/build.py                      # reads the feeder sheet (needs credentials)

See HALLOWEEN-PLAN.md for the schema and the reasoning behind it.
"""

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

FESTIVAL_YEAR = 2026
HERE = Path(__file__).resolve().parent

# A blank cell inherits; this marker means "genuinely empty, do not inherit".
EXPLICIT_EMPTY = "-"

# Columns that participate in fill-down.  `date` deliberately does not.
INHERITABLE = ["venue", "price", "time", "url", "description", "tags"]

# Accepted spellings for each canonical column.  Order-independent, extra
# columns ignored, so the feeder can carry working notes we do not read.
COLUMN_ALIASES = {
    "name":        ["name", "event", "event_name", "event name", "title"],
    "recurring":   ["recurring", "recurs", "repeat", "repeating"],
    "date":        ["date", "day", "dates"],
    "venue":       ["venue", "location", "place", "where"],
    "price":       ["price", "cost", "admission", "cover"],
    "time":        ["time", "start", "start_time", "when"],
    "url":         ["url", "link", "website", "event_url"],
    "description": ["description", "desc", "blurb", "details"],
    "tags":        ["tags", "tag", "categories", "category"],
    "status":      ["status", "state"],
    "notes":       ["notes", "note", "internal", "private"],
}

# Deterministic tag palette.  A tag hashes to a fixed slot, so a given tag keeps
# its colour across rebuilds and across the season without any configuration.
TAG_PALETTE = [
    "#bb124d", "#0f3934", "#c2571a", "#5b3a8e", "#1d6a5f",
    "#8c1f3d", "#3b5ea8", "#a8551f", "#2f7d4f", "#6e2472",
    "#b03a2e", "#17605b", "#7d4e24", "#4a4a8c", "#8a2f5e",
]

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
WEEKDAY_PREFIX = re.compile(
    r"^(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+", re.I
)


class BuildError(Exception):
    """A problem that must stop the build."""


# ─────────────────────────────────────────────────────────────────────────────
# Parsing helpers
# ─────────────────────────────────────────────────────────────────────────────

def norm_header(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")


def map_columns(headers):
    """Map the sheet's header row onto canonical column names."""
    lookup = {}
    for alias_list, canon in ((v, k) for k, v in COLUMN_ALIASES.items()):
        for a in alias_list:
            lookup[norm_header(a)] = canon
    mapping = {}
    for idx, h in enumerate(headers):
        canon = lookup.get(norm_header(h))
        if canon and canon not in mapping:
            mapping[canon] = idx
    missing = [c for c in ("name", "date") if c not in mapping]
    if missing:
        raise BuildError(
            f"feeder is missing required column(s): {', '.join(missing)}\n"
            f"  saw headers: {', '.join(h for h in headers if h.strip())}"
        )
    return mapping


def parse_date(raw, year=FESTIVAL_YEAR):
    """
    Accepts: 10/25 · 10/25/26 · Fri 10/31 · Oct 25 · October 25, 2026 ·
             2026-10-25 · 'all month'.
    Returns an ISO date string, or the literal 'all-month'.
    """
    s = (raw or "").strip()
    if not s:
        return None
    low = s.lower().replace("’", "'")
    if low in ("all month", "all month long", "all-month", "allmonth", "monthly"):
        return "all-month"

    s = WEEKDAY_PREFIX.sub("", s).strip()

    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        y, mo, d = (int(g) for g in m.groups())
        return _iso(y, mo, d, raw)

    m = re.match(r"^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$", s)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if y is None:
            y = year
        else:
            y = int(y)
            if y < 100:
                y += 2000
        return _iso(y, mo, d, raw)

    m = re.match(r"^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$", s)
    if m:
        mon = MONTHS.get(m.group(1)[:4].lower()) or MONTHS.get(m.group(1)[:3].lower())
        if mon:
            return _iso(int(m.group(3) or year), mon, int(m.group(2)), raw)

    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s*,?\s*(\d{4}))?$", s)
    if m:
        mon = MONTHS.get(m.group(2)[:4].lower()) or MONTHS.get(m.group(2)[:3].lower())
        if mon:
            return _iso(int(m.group(3) or year), mon, int(m.group(1)), raw)

    raise BuildError(f"unrecognised date {raw!r}")


def _iso(y, mo, d, raw):
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        raise BuildError(f"impossible date {raw!r}")


def split_tags(raw):
    if not raw:
        return []
    parts = re.split(r"[,;/]+", raw)
    return [p.strip().lower() for p in parts if p.strip()]


def tag_color(tag):
    h = 0
    for ch in tag:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return TAG_PALETTE[h % len(TAG_PALETTE)]


def slugify(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "event"


# ─────────────────────────────────────────────────────────────────────────────
# Fill-down resolution
# ─────────────────────────────────────────────────────────────────────────────

def resolve(rows, mapping):
    """
    Walk the feeder rows, resolving blanks against the nearest non-blank value
    above within the same block.  A non-blank `name` starts a new block;
    inheritance never crosses that boundary.

    Returns (occurrences, errors, warnings).
    """
    occurrences, errors, warnings = [], [], []
    carry = {}            # column -> last seen value, current block only
    block_name = None
    block_start_line = None

    def cell(row, col):
        idx = mapping.get(col)
        if idx is None or idx >= len(row):
            return ""
        return (row[idx] or "").strip()

    for line_no, row in enumerate(rows, start=2):   # line 1 is the header
        if not any((c or "").strip() for c in row):
            continue

        name = cell(row, "name")
        if name:
            block_name = name
            block_start_line = line_no
            carry = {}                               # boundary: nothing carries in

        if block_name is None:
            warnings.append(
                f"line {line_no}: row before any named event — skipped"
            )
            continue

        raw_date = cell(row, "date")
        if not raw_date:
            errors.append(
                f"line {line_no}: no date. Every occurrence needs its own date "
                f"(dates are never inherited). Event: {block_name!r}"
            )
            continue
        try:
            iso = parse_date(raw_date)
        except BuildError as e:
            errors.append(f"line {line_no}: {e}")
            continue

        resolved = {"name": block_name, "date": iso, "date_raw": raw_date}
        for col in INHERITABLE:
            raw = cell(row, col)
            if raw == EXPLICIT_EMPTY:
                resolved[col] = ""
                carry[col] = ""
                resolved.setdefault("_explicit", []).append(col)
            elif raw:
                resolved[col] = raw
                carry[col] = raw
            else:
                resolved[col] = carry.get(col, "")
                if col in carry:
                    resolved.setdefault("_inherited", []).append(col)

        status = (cell(row, "status") or "confirmed").strip().lower()
        resolved["status"] = status
        resolved["line"] = line_no
        resolved["block_start"] = block_start_line

        if status in ("cancelled", "canceled", "cancel"):
            continue
        if not resolved["venue"]:
            warnings.append(
                f"line {line_no}: {block_name!r} has no venue"
            )
        occurrences.append(resolved)

    return occurrences, errors, warnings


# ─────────────────────────────────────────────────────────────────────────────
# Tag discovery + typo detection
# ─────────────────────────────────────────────────────────────────────────────

def edit_distance_one(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    if a == b:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = j = 0
    skipped = False
    while i < len(short) and j < len(long):
        if short[i] != long[j]:
            if skipped:
                return False
            skipped = True
            j += 1
            continue
        i += 1
        j += 1
    return True


def discover_tags(occurrences):
    counts = Counter()
    for o in occurrences:
        for t in split_tags(o.get("tags")):
            counts[t] += 1

    suspects = []
    tags = list(counts)
    for i, a in enumerate(tags):
        for b in tags[i + 1:]:
            reason = None
            if a.lower() == b.lower() and a != b:
                reason = "case variant"
            elif a.rstrip("s") == b.rstrip("s") and a != b:
                reason = "singular/plural"
            elif edit_distance_one(a, b):
                reason = "one character apart"
            if reason:
                suspects.append((a, counts[a], b, counts[b], reason))

    tag_list = [
        {"tag": t, "count": c, "color": tag_color(t)}
        for t, c in counts.most_common()
    ]
    return tag_list, suspects


# ─────────────────────────────────────────────────────────────────────────────
# Output
# ─────────────────────────────────────────────────────────────────────────────

def build_events(occurrences):
    events = []
    seen = Counter()
    for o in occurrences:
        base = slugify(o["name"])
        seen[base] += 1
        events.append({
            "id": f"{base}-{o['date']}-{seen[base]}",
            "name": o["name"],
            "date": o["date"],
            "venue": o["venue"],
            "price": o["price"],
            "time": o["time"],
            "url": o["url"],
            "description": o["description"],
            "tags": split_tags(o.get("tags")),
            "status": o["status"],
        })
    events.sort(key=lambda e: (e["date"] != "all-month", e["date"], e["name"]))
    return events


def build_venues(occurrences):
    counts = Counter(o["venue"] for o in occurrences if o["venue"])
    return [{"venue": v, "count": c} for v, c in sorted(counts.items())]


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────

def report(occurrences, errors, warnings, tag_list, suspects, verbose):
    by_event = defaultdict(list)
    for o in occurrences:
        by_event[o["name"]].append(o)
    recurring = {k: v for k, v in by_event.items() if len(v) > 1}

    print(f"\n{len(occurrences)} occurrences · {len(by_event)} unique events "
          f"· {len(recurring)} recurring · {len(tag_list)} tags")

    if verbose:
        print("\n── resolved occurrences (blanks filled in) ─────────────────")
        hdr = f"{'date':11} {'name':34} {'venue':26} {'price':9} {'time':12}"
        print(hdr)
        print("-" * len(hdr))
        for o in occurrences:
            marks = ""
            if o.get("_inherited"):
                marks = "  ← " + ",".join(sorted(set(o["_inherited"])))
            print(f"{o['date']:11} {o['name'][:34]:34} {o['venue'][:26]:26} "
                  f"{o['price'][:9]:9} {o['time'][:12]:12}{marks}")

    if tag_list:
        print("\n── tags discovered ────────────────────────────────────────")
        for t in tag_list:
            print(f"  {t['count']:4}  {t['tag']:24} {t['color']}")
    else:
        print("\n── tags discovered ────────────────────────────────────────")
        print("  (none yet — the tags column is empty)")

    if suspects:
        print("\n── possible tag typos (warnings, not errors) ──────────────")
        for a, ca, b, cb, why in suspects:
            print(f"  {a!r} ({ca}) vs {b!r} ({cb}) — {why}")

    if warnings:
        print(f"\n── warnings ({len(warnings)}) ─────────────────────────────")
        for w in warnings[:40]:
            print(f"  {w}")
        if len(warnings) > 40:
            print(f"  ... and {len(warnings) - 40} more")

    if errors:
        print(f"\n── ERRORS ({len(errors)}) ─────────────────────────────────")
        for e in errors:
            print(f"  {e}")


# ─────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Halloween tracker ingest")
    ap.add_argument("--csv", help="read a CSV export instead of the live sheet")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate and print resolved rows; write nothing")
    ap.add_argument("--out", default=str(HERE),
                    help="directory for events.json / venues.json / tags.json")
    ap.add_argument("--quiet", action="store_true",
                    help="skip the resolved-occurrence table")
    args = ap.parse_args()

    if not args.csv:
        print("Live Google Sheets reading is not wired up yet — it needs the "
              "service-account credentials.\nFor now export the feeder tab and "
              "pass --csv path/to/export.csv", file=sys.stderr)
        return 2

    src = Path(args.csv)
    if not src.exists():
        print(f"no such file: {src}", file=sys.stderr)
        return 2

    with src.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        print("feeder is empty", file=sys.stderr)
        return 2

    try:
        mapping = map_columns(rows[0])
    except BuildError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    occurrences, errors, warnings = resolve(rows[1:], mapping)
    tag_list, suspects = discover_tags(occurrences)

    report(occurrences, errors, warnings, tag_list, suspects,
           verbose=args.dry_run and not args.quiet)

    if errors:
        print(f"\nnot writing output — {len(errors)} error(s) to fix first.")
        return 1

    if args.dry_run:
        print("\ndry run — nothing written.")
        return 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "events.json", build_events(occurrences))
    write_json(out / "venues.json", build_venues(occurrences))
    write_json(out / "tags.json", tag_list)
    print(f"\nwrote events.json ({len(occurrences)}), venues.json, tags.json "
          f"to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
