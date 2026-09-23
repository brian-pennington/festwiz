#!/usr/bin/env python3
"""
publish.py — write the public Halloween sheet

Reads events.json (produced by build.py) and rewrites the public sheet to
match the layout of the 2025 guide: a title bar, a frozen header, then one
section per date — black banner, event rows on a rotating pastel, a blank
row, and the newsletter promo row.

    python3 halloween/publish.py --preview    # print what would be written
    python3 halloween/publish.py              # write it (asks first)
    python3 halloween/publish.py --yes        # write without asking

The 2025 sheet carries no conditional-formatting rules — every fill is
applied directly to cells — so this writes formatting as well as values.
"""

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CREDENTIALS = REPO / "credentials" / "credentials.json"

# Every subscribe link on the sheet points here. The 2025 sheet still used the
# old Mailchimp eepurl address in all 36 places; this is the single source now.
SUBSCRIBE_URL = "https://liteandbriteatx.beehiiv.com/?modal=signup"

TITLE = ("This spreadsheet compiled w/love ",
         "by Lite + Brite, a weekly email newsletter of Austin events")

PROMO = "Subscribe to the Lite + Brite newsletter for more Austin events"

HEADERS = ["Name", "Location", "Price", "Time", "Description"]

# One Halloween-themed fill per day, cycling through six, as in the 2025 sheet.
# "All Month Long" is a day like any other and takes the first colour.
PALETTE = [
    "#f4cccc",   # blood
    "#f6b674",   # pumpkin
    "#d0e0e3",   # moonlight
    "#d9d2e9",   # witch
    "#b6d7a8",   # slime
    "#cccccc",   # tombstone
]

TITLE_BG = "#e69138"
BANNER_BG = "#000000"
WHITE = "#ffffff"

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

_TIME = re.compile(r"(\d{1,2})(?::([0-5]\d))?\s*(am|pm)", re.I)


def time_key(t):
    """
    Sort a day's events by start time. Free-text times ("various") have no
    clock position, so they lead the section — which is where the 2025 sheet
    tends to put them. Returns (bucket, minutes, text) for a stable order.
    """
    m = _TIME.search(t or "")
    if not m:
        return (0, 0, (t or "").lower())
    h = int(m.group(1)) % 12
    if m.group(3).lower() == "pm":
        h += 12
    mins = h * 60 + int(m.group(2) or 0)
    # Treat after-midnight starts as belonging to the night before.
    if mins < 6 * 60:
        mins += 24 * 60
    return (1, mins, "")


def rgb(hex_color):
    h = hex_color.lstrip("#")
    return {"red": int(h[0:2], 16) / 255,
            "green": int(h[2:4], 16) / 255,
            "blue": int(h[4:6], 16) / 255}


def esc(s):
    return (s or "").replace('"', '""')


def link(url, text):
    """A HYPERLINK formula — regenerates cleanly on every rewrite."""
    if not url:
        return text or ""
    return f'=HYPERLINK("{esc(url)}","{esc(text)}")'


def section_label(iso):
    if iso == "all-month":
        return "All Month Long"
    y, m, d = (int(x) for x in iso.split("-"))
    dt = date(y, m, d)
    return f"{WEEKDAYS[dt.weekday()]} {dt.month}/{dt.day}"


def build_rows(events, include_empty_dates=True):
    """
    Returns (rows, spans) where rows is a list of 5-cell lists and spans
    records which row indices are banners, promos and section bodies, so
    formatting can be applied without re-deriving the structure.
    """
    by_date = {}
    for e in events:
        by_date.setdefault(e["date"], []).append(e)

    dated = sorted(d for d in by_date if d != "all-month")
    sections = []
    if "all-month" in by_date:
        sections.append("all-month")
    if dated and include_empty_dates:
        first = date.fromisoformat(dated[0])
        last = date.fromisoformat(dated[-1])
        cur = first
        while cur <= last:
            sections.append(cur.isoformat())
            cur += timedelta(days=1)
    else:
        sections.extend(dated)

    rows = [
        [link(SUBSCRIBE_URL, TITLE[0]), link(SUBSCRIBE_URL, TITLE[1]), "", "", ""],
        HEADERS[:],
        ["", "", "", "", ""],
    ]
    spans = {"title": 0, "header": 1, "banners": [], "promos": [], "bodies": []}

    for n, iso in enumerate(sections):
        spans["banners"].append(len(rows))
        rows.append([section_label(iso), "", "", "", ""])

        body_start = len(rows)
        for e in sorted(by_date.get(iso, []),
                        key=lambda x: (time_key(x.get("time", "")),
                                       x["name"].lower())):
            rows.append([
                link(e.get("url"), e["name"]),
                e.get("venue", ""),
                e.get("price", ""),
                e.get("time", ""),
                e.get("description", ""),
            ])
        rows.append(["", "", "", "", ""])          # blank row inside the fill
        spans["promos"].append(len(rows))
        rows.append([link(SUBSCRIBE_URL, PROMO), "", "", "", ""])
        spans["bodies"].append((body_start, len(rows), PALETTE[n % len(PALETTE)]))

    return rows, spans


def text_format_requests(sheet_id, n_rows, n_cols=5):
    """
    Force columns B-E to TEXT *before* any values are written.

    ws.clear() removes values but not formats, so a cell still carrying a time
    format from a previous sheet re-coerces "7:30pm" into "7:30 PM" on write.
    Prices like "$15" would likewise parse as currency. TEXT stops both.

    Column A is deliberately left alone: it holds =HYPERLINK() formulas, and a
    TEXT-formatted cell stores a formula as literal text instead of running it.
    """
    return [{"repeatCell": {
        "range": {"sheetId": sheet_id, "startRowIndex": 0,
                  "endRowIndex": max(n_rows, 400),
                  "startColumnIndex": 1, "endColumnIndex": n_cols},
        "cell": {"userEnteredFormat": {"numberFormat": {"type": "TEXT"}}},
        "fields": "userEnteredFormat.numberFormat"}}]


def format_requests(sheet_id, rows, spans, n_cols=5):
    """batchUpdate requests recreating the 2025 look."""
    req = []

    def repeat(start, end, fmt, fields):
        req.append({"repeatCell": {
            "range": {"sheetId": sheet_id, "startRowIndex": start,
                      "endRowIndex": end, "startColumnIndex": 0,
                      "endColumnIndex": n_cols},
            "cell": {"userEnteredFormat": fmt},
            "fields": fields}})

    # Wipe formatting across the whole written range first, so a shorter
    # rebuild cannot leave last run's colours stranded below the new content.
    #
    repeat(0, max(len(rows), 400),
           {"backgroundColor": rgb("#ffffff"),
            "textFormat": {"bold": False, "fontSize": 11,
                           "foregroundColor": rgb("#000000")}},
           "userEnteredFormat(backgroundColor,textFormat)")

    repeat(spans["title"], spans["title"] + 1,
           {"backgroundColor": rgb(TITLE_BG),
            "textFormat": {"fontSize": 18, "bold": False}},
           "userEnteredFormat(backgroundColor,textFormat)")

    repeat(spans["header"], spans["header"] + 1,
           {"backgroundColor": rgb(BANNER_BG),
            "textFormat": {"fontSize": 14, "bold": True,
                           "foregroundColor": rgb(WHITE)}},
           "userEnteredFormat(backgroundColor,textFormat)")

    for r in spans["banners"]:
        repeat(r, r + 1,
               {"backgroundColor": rgb(BANNER_BG),
                "textFormat": {"fontSize": 18, "bold": False,
                               "foregroundColor": rgb(WHITE)}},
               "userEnteredFormat(backgroundColor,textFormat)")

    for start, end, colour in spans["bodies"]:
        if end > start:
            repeat(start, end,
                   {"backgroundColor": rgb(colour),
                    "textFormat": {"fontSize": 11,
                                   "foregroundColor": rgb("#000000")}},
                   "userEnteredFormat(backgroundColor,textFormat)")

    for r in spans["promos"]:
        req.append({"repeatCell": {
            "range": {"sheetId": sheet_id, "startRowIndex": r, "endRowIndex": r + 1,
                      "startColumnIndex": 0, "endColumnIndex": n_cols},
            "cell": {"userEnteredFormat": {"textFormat": {"fontSize": 10}}},
            "fields": "userEnteredFormat.textFormat.fontSize"}})

    req.append({"updateSheetProperties": {
        "properties": {"sheetId": sheet_id,
                       "gridProperties": {"frozenRowCount": 2,
                                          "frozenColumnCount": 1}},
        "fields": "gridProperties(frozenRowCount,frozenColumnCount)"}})
    return req


def main():
    ap = argparse.ArgumentParser(description="Write the public Halloween sheet")
    ap.add_argument("--preview", action="store_true",
                    help="print the rows that would be written; touch nothing")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation")
    ap.add_argument("--no-empty-dates", action="store_true",
                    help="omit banners for dates with no events")
    args = ap.parse_args()

    cfg = json.loads((HERE / "config.json").read_text())
    events = json.loads((HERE / "events.json").read_text())
    if not events:
        print("events.json is empty — run build.py first.", file=sys.stderr)
        return 2

    rows, spans = build_rows(events, include_empty_dates=not args.no_empty_dates)
    n_sections = len(spans["banners"])
    n_events = sum(1 for r in rows
                   if r[0] and not r[0].startswith(f'=HYPERLINK("{SUBSCRIBE_URL}"')
                   and r[0] not in HEADERS and r[0] != TITLE[0]
                   and r != ["", "", "", "", ""]) - n_sections

    print(f"{len(events)} occurrences · {n_sections} sections · {len(rows)} rows")

    if args.preview:
        print("\n── preview (first 30 rows) ─────────────────────────────")
        for i, r in enumerate(rows[:30], start=1):
            kind = ("TITLE" if i - 1 == spans["title"] else
                    "HEADER" if i - 1 == spans["header"] else
                    "BANNER" if i - 1 in spans["banners"] else
                    "PROMO" if i - 1 in spans["promos"] else
                    "")
            cell = r[0][:46]
            print(f"  {i:3} {kind:7} {cell:48} {r[1][:20]:20} {r[3][:9]}")
        print(f"\n  ... {len(rows) - 30} more rows")
        print("\npreview only — nothing written.")
        return 0

    if not args.yes:
        print(f"\nThis REPLACES every cell in "
              f"{cfg.get('public_tab')!r} of the public sheet.")
        if input("Type 'write' to continue: ").strip() != "write":
            print("aborted.")
            return 1

    import gspread
    from google.oauth2.service_account import Credentials
    creds = Credentials.from_service_account_file(
        str(CREDENTIALS), scopes=["https://www.googleapis.com/auth/spreadsheets"])
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(cfg["public_sheet"])
    ws = sh.worksheet(cfg["public_tab"])

    need = len(rows) + 20
    if ws.row_count < need:
        ws.add_rows(need - ws.row_count)
    ws.clear()
    # TEXT format must land before the values, or Sheets parses them on the way in.
    sh.batch_update({"requests": text_format_requests(ws.id, len(rows))})
    ws.update(rows, "A1", value_input_option="USER_ENTERED")
    sh.batch_update({"requests": format_requests(ws.id, rows, spans)})
    print(f"wrote {len(rows)} rows to {cfg['public_tab']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
