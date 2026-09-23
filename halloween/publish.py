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

HEADERS = ["Name", "Location", "Price", "Time", "Age", "Tags", "Description"]
N_COLS = len(HEADERS)

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


def link_requests(sheet_id, rows, links):
    """
    Real inserted hyperlinks, written as a textFormatRun on the cell.

    This is what the 2025 sheet used. A =HYPERLINK() formula renders a link
    too, but it leaves formula markup in the cell, exports as a formula, and
    depends on recalculation. A textFormatRun link is an ordinary Sheets
    hyperlink: underlined, clickable, and plain text when exported.

    Must be applied AFTER the colour passes — repeatCell writing textFormat
    would otherwise clobber these runs.
    """
    req = []
    for row_idx, url in sorted(links.items()):
        text = rows[row_idx][0]
        if not text:
            continue
        req.append({"updateCells": {
            "range": {"sheetId": sheet_id, "startRowIndex": row_idx,
                      "endRowIndex": row_idx + 1,
                      "startColumnIndex": 0, "endColumnIndex": 1},
            "rows": [{"values": [{
                "userEnteredValue": {"stringValue": text},
                "textFormatRuns": [{"startIndex": 0,
                                    "format": {"link": {"uri": url},
                                               "underline": True}}],
            }]}],
            "fields": "userEnteredValue,textFormatRuns"}})
    return req


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

    def blank():
        return [""] * N_COLS

    title = blank()
    title[0], title[1] = TITLE[0], TITLE[1]
    rows = [title, HEADERS[:], blank()]
    links = {0: SUBSCRIBE_URL}          # row index -> url for column A
    spans = {"title": 0, "header": 1, "banners": [], "promos": [], "bodies": []}

    for n, iso in enumerate(sections):
        spans["banners"].append(len(rows))
        banner = blank()
        banner[0] = section_label(iso)
        rows.append(banner)

        body_start = len(rows)
        for e in sorted(by_date.get(iso, []),
                        key=lambda x: (time_key(x.get("time", "")),
                                       x["name"].lower())):
            if e.get("url"):
                links[len(rows)] = e["url"]
            rows.append([
                e["name"],
                e.get("venue", ""),
                e.get("price", ""),
                e.get("time", ""),
                e.get("age", ""),
                ", ".join(e.get("tags", [])),
                e.get("description", ""),
            ])
        rows.append(blank())                      # blank row inside the fill
        spans["promos"].append(len(rows))
        links[len(rows)] = SUBSCRIBE_URL
        promo = blank()
        promo[0] = PROMO
        rows.append(promo)
        spans["bodies"].append((body_start, len(rows), PALETTE[n % len(PALETTE)]))

    spans["links"] = links
    return rows, spans


def text_format_requests(sheet_id, n_rows, n_cols=N_COLS):
    """
    Force columns B-E to TEXT *before* any values are written.

    ws.clear() removes values but not formats, so a cell still carrying a time
    format from a previous sheet re-coerces "7:30pm" into "7:30 PM" on write.
    Prices like "$15" would likewise parse as currency. TEXT stops both.

    Column A is left alone so its hyperlink runs are not disturbed.
    """
    return [{"repeatCell": {
        "range": {"sheetId": sheet_id, "startRowIndex": 0,
                  "endRowIndex": max(n_rows, 400),
                  "startColumnIndex": 1, "endColumnIndex": n_cols},
        "cell": {"userEnteredFormat": {"numberFormat": {"type": "TEXT"}}},
        "fields": "userEnteredFormat.numberFormat"}}]


def format_requests(sheet_id, rows, spans, n_cols=N_COLS):
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
    print(f"{len(events)} occurrences · {n_sections} sections · "
          f"{len(rows)} rows · {len(spans['links'])} links")

    if args.preview:
        print("\n── preview (first 30 rows; * = hyperlinked) ────────────")
        print(f"      {'kind':7} {'name':36} {'venue':18} {'time':8} "
              f"{'age':9} tags")
        for i, r in enumerate(rows[:30], start=1):
            kind = ("TITLE" if i - 1 == spans["title"] else
                    "HEADER" if i - 1 == spans["header"] else
                    "BANNER" if i - 1 in spans["banners"] else
                    "PROMO" if i - 1 in spans["promos"] else
                    "")
            mark = "*" if (i - 1) in spans["links"] else " "
            print(f"  {i:3} {kind:7}{mark}{r[0][:34]:36} {r[1][:18]:18} "
                  f"{r[3][:8]:8} {r[4][:9]:9} {r[5][:18]}")
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
    # Links last: the colour passes above would overwrite the text runs.
    lreq = link_requests(ws.id, rows, spans["links"])
    for i in range(0, len(lreq), 200):
        sh.batch_update({"requests": lreq[i:i + 200]})
    print(f"wrote {len(rows)} rows and {len(lreq)} links to {cfg['public_tab']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
