# FestWiz — Halloween Tracker Plan

Plan of record for adding an Austin Halloween event tracker to FestWiz while
preserving the 2026 South by Southwest app intact for reuse in 2027 prep.

Status: **Phase 1 complete, pending preview-deploy verification.**
2025 source format analyzed, schema derived.
Written 2026-09-16.

## Goals

1. Maintain Halloween events in a private **feeder sheet**, the same working
   style as the festival app's unofficial-shows CSV.
2. One compile command ingests that sheet and exports two ways:
   - a **public Google Sheet** that closely matches the Halloween 2025 sheet
   - a **web app** on festwiz.biz, FestWiz-styled, filterable by date,
     venue, and tag
3. **Preserve the festival app completely.** It stays deployed and reachable, and
   festwiz.biz reverts to it after Halloween with a one-file change.

## Architecture

### Why not a branch

The obvious read of "keep a copy I can revert to" is a git branch. That does not
work here, because the festival app must stay *live and reachable from the About section*
while Halloween is the front page. Branches give you one deployed app at a time.

Instead: **one repo, two apps as sibling directories, both always deployed.**
Mode becomes a routing file, not a branch.

```
festwiz/
  _redirects            ← the mode switch (one line)
  southbysouthwest/                 ← today's app, moved wholesale, then frozen
    index.html  app.js  schedule.html  schedule.js  style.css
    service-worker.js  manifest.json  *.json  icons
  halloween/            ← new app, forked from southbysouthwest/
    index.html  halloween.js  style.css
    service-worker.js  manifest.json
    build.py            ← Sheets in, Sheets + JSON out
    events.json  venues.json  tags.json   ← generated, committed
  shared/
    brand.css           ← color tokens only
    FestWiz.svg
```

`southbysouthwest-2026-final` is tagged before any of this starts, as a hard floor.

### Mode switching

Cloudflare Pages reads `_redirects`. A `200` is a rewrite (URL stays `/`),
not a visible redirect.

```
# Halloween mode
/*    /halloween/:splat    200

# Festival mode — comment the above, uncomment this
# /*  /southbysouthwest/:splat         200
```

Flipping modes is one commit to one file, plus swapping the About-section link
between `/southbysouthwest/` and `/halloween/`. Both apps stay reachable at their own paths
in either mode.

### Styling: fork, don't share

`style.css` is ~70KB and shared today by `index.html` and `schedule.html`. The
Halloween layout diverges substantially. If Halloween shared that stylesheet,
every Halloween tweak would risk the festival views being reused in January.

So `halloween/style.css` is a **full fork**. Only color tokens and the logo live
in `shared/`. Accept the drift; cherry-pick anything worth keeping in 2027.

### Service workers

Two apps, two service workers, two scopes, two cache names:

- `/southbysouthwest/service-worker.js` — scope `/southbysouthwest/`, cache `fw-sbsw-vNNN`
- `/halloween/service-worker.js` — scope `/halloween/`, cache `fw-hw-vNNN`

Both keep the existing strategy: explicit `PRECACHE` list for the app shell,
network-first for `.json` and `.css`, `CACHE_NAME` bumped every data push.
All precache paths need the new directory prefix.

**Existing PWA installs stay on the festival app** (decided). Mechanism: ship one final
service worker at the *root* scope whose only job is to redirect its already
registered clients to `/southbysouthwest/`. New visitors never registered it, so they get
Halloween normally.

Caveat worth knowing: this also bounces returning *browser* users who visited
during the festival, not just installed apps — a service worker cannot reliably detect
standalone display mode. Mitigation is a "Looking for Halloween? →" banner on
the festival page rather than trying to distinguish them.

## The pipeline

```
Feeder Sheet ──read──> halloween/build.py ──> events.json / venues.json / tags.json
  (private)                   │                            │
                              └──write──> Public Sheet      └──> festwiz.biz grid
```

One command does everything:

```bash
python3 halloween/build.py           # read feeder, write JSON + public sheet
python3 halloween/build.py --dry-run # validate and report, write nothing
python3 halloween/build.py --no-sheet # JSON only, skip the Sheets write
```

This is `build_unofficial.py` grown up: same forgiving date/time parsing, same
header-driven and order-independent columns, but reading the sheet directly
instead of a downloaded CSV, and writing back out.

### Google auth

Both directions use **one service account**:

1. Google Cloud console → new project → enable the **Google Sheets API**
2. Create a service account, create a JSON key, download it
3. Save as `halloween/credentials.json` — **add to `.gitignore` immediately**
4. Share the **feeder sheet** with the service account email as **Viewer**
5. Share the **public sheet** with the same email as **Editor**

```bash
pip install gspread google-auth
```

The service account email looks like
`festwiz-halloween@<project>.iam.gserviceaccount.com`. Sheet IDs go in
`halloween/config.json` (committed; IDs are not secrets, the sharing is what
grants access).

### Public sheet: template, not generated formatting

**The script writes values only.** It never writes colors, borders, or column
widths.

Set the output sheet up once by hand — header row, frozen panes, column widths,
and **conditional formatting rules** keyed to the tag and date columns. The
script clears and rewrites a fixed value range beneath the header; the rules
recolor everything automatically.

The alternative — generating formatting via `batchUpdate` — is a few hundred
lines of brittle API calls, and every visual tweak becomes a code change. With
rules, the sheet is restyled in the Sheets UI and `build.py` never changes.

## Source format: the 2025 sheet

Analyzed from `Lite + Brite's Guide to ATX Halloween 2025 - Halloween Events by Date.csv`
([sheet](https://docs.google.com/spreadsheets/d/1UmB8YbY8dS6yGHLuqNyTrkAnw9iiWgaSMrPpO83b3zk/edit?gid=1857198146)).

**It is a date-sectioned flat list, not a grid.** Structure:

```
Title banner        "This spreadsheet compiled w/love by Lite + Brite..."  (orange, merged)
Header row          Name | Location | Price | Time | Description          (black, bold, frozen)
"All Month Long"    section banner (black, white text, large)
  ...12 event rows                                                        (pastel fill)
  promo row         "Subcribe to the Lite + Brite newsletter..."
"Wed 10/1"          section banner
  ...event rows                                                           (next pastel fill)
  promo row
...repeats through "Sun 11/2"
```

- **34 sections** — `All Month Long` plus every date from `Wed 10/1` to `Sun 11/2`
  (it runs past Halloween into the following weekend).
- **243 event rows, 167 unique events.** Five columns only.
- Each date block gets the next color from a **rotating pastel palette**; banners
  are black. Column A is frozen.
- **Event names are hyperlinked in the sheet.** CSV export drops the links
  entirely — so the URL must be its own column in the feeder.
- The promo row repeats after every section (34 times), so it is generated, not authored.
- Two sections were empty (10/7, 10/15, 10/21) and still got a banner.

Two observations worth acting on separately: the promo row reads "**Subcribe**"
(missing the `s`) in all 34 copies, and prices include one literal `?` with 20 blanks.
The generated version fixes the typo in one place.

### The recurrence problem

**76 of the 243 rows are repeats of an event on another day**, and the repeats are
*not* identical. Of 22 recurring events, **14 vary** across their dates:

| Event | What varies |
|---|---|
| Austin Witches Market | **Venue and time** change every date (5 different venues) |
| Jane of the Dead | 7pm Sat / 6pm Sun, then moves venue and price on 10/31 |
| UNDEAD Haunted House of Dances | 7pm weeknights, `6pm and 8pm` on Sat and Halloween |
| Austin Horror Film Festival | `6pm-2am` Fri, `12-9pm` Sat |
| Egg Party Presents AHHHHHHHHHHH | 7pm except 8:30pm Friday |
| Meow-lloween Movie Night | Identical all 3 dates |

So a naive "one row with a date range" model breaks on more than half of them.
The schema below handles both cases.

## Feeder sheet schema

Three tabs. Header row required; column order does not matter; unknown columns ignored.

### Tab `events` — one row per *occurrence*, with fill-down inheritance

| Column | Required | Notes |
|---|---|---|
| `name` | first row of a block | Event name. A non-blank name **starts a new block**. |
| `recurring` | | `yes` / `no`. Marks a block as having continuation rows beneath it. |
| `date` | ✅ **every row** | `10/25` · `Fri 10/31` · `all month`. Never inheritable. |
| `venue` | | Display name, resolved via the `venues` tab. |
| `price` | | Verbatim: `$15` · `$13-$83+` · `free` · `donation`. |
| `time` | | Verbatim: `8pm` · `6-10pm` · `varies` · `6pm and 8pm`. |
| `url` | | Link for the name cell. The thing CSV export loses. |
| `description` | | The blurb. |
| `tags` | | Comma-separated, from the `tags` tab. |
| `status` | | `confirmed` (default) · `rumored` · `cancelled`. Cancelled rows are excluded from both exports but kept in the feeder. |
| `notes` | | Private. **Never exported.** |

### Fill-down inheritance

A blank cell means **"same as the last row above it that had a value."** This is the
ditto convention the sheet already reads with visually, and it is the only recurrence
mechanism — there is no separate series tab and no comma-separated date list.

Resolution rules:

1. **Blocks.** A row with a non-blank `name` starts a block. The block ends at the
   next row with a non-blank `name`. **Inheritance never crosses a block boundary** —
   without this, a blank venue on an unrelated event further down the sheet would
   silently pick up a value from a different event.
2. **Chaining.** Inheritance walks up to the nearest non-blank value in that column
   within the block, not to the block's first row. So an event can change venue on
   occurrence 2 and have occurrences 3 and 4 inherit *that* venue.
3. **`date` is never inherited.** Every row carries its own date. A continuation row
   with no date is a hard error, not a warning — otherwise a stray blank row is
   indistinguishable from an occurrence.
4. **Explicit empty.** A literal `-` means "this field is genuinely empty, do not
   inherit." Needed because blank already means inherit — and real events do have no
   price (20 of them in 2025, plus one literal `?`).
5. `recurring` is informational and may be left blank on continuation rows. Block
   structure is determined by the `name` column, not by this flag.

Worked example, the hardest case from 2025 — venue *and* time change every date:

```
name                  | date      | venue            | price | time
Austin Witches Market | Sat 10/11 | Cosmic Saltillo  | free  | 6-10pm
                      | Sun 10/12 | Radio East       |       | 12-4pm
                      | Sat 10/18 | Brewtorium       |       |
                      | Sat 10/25 | Drinks Backyard  |       | 6-10pm
                      | Sun 10/26 | Far Out Lounge   |       |
```

Row 3's blank time resolves to `12-4pm` (row 2), not `6-10pm` (row 1). Price and
description are typed once and inherited by all five.

Against the 2025 data this is ~23% fewer cells overall, but the saving is
concentrated in the long ones: 166 descriptions written instead of 239.

### Validating inherited values

Inheritance is **invisible in the feeder** — a blank cell looks identical whether it
means "same as above" or "I have not filled this in yet." That makes a mistake silent
rather than loud, so:

`--dry-run` prints every occurrence with all blanks **already resolved**, so the
inherited values can be eyeballed before anything reaches the public sheet. It also
reports: rows missing a date, tags absent from the `tags` tab, venues absent from the
`venues` tab, and any block whose first row is missing a required field.

### Tab `tags` — controlled vocabulary

`tag`, `display_name`, `color`, `sort_order`. Drives both the web app filter chips
and the sheet's conditional formatting, so the two cannot drift.

Starting vocabulary, derived from the 2025 descriptions (counts are how many of the
167 unique 2025 events a keyword scan matched, as a rough sizing check):

| Tag | 2025 | Tag | 2025 |
|---|---|---|---|
| `music` | 46 | `haunted` | 18 |
| `film` | 36 | `food-drink` | 9 |
| `drag-burlesque` | 34 | `comedy-theater` | 9 |
| `costume` | 32 | `family` | 5 |
| `market` | 25 | `literary` | — |
| `art-craft` | 22 | `queer` | — |

26 events matched nothing — immersive theater, storytelling, live podcast tapings,
costume sales, a living-funeral ceremony — so `literary`, `immersive` and `misc`
are likely additions. Worth finalizing against the real data rather than guessing.

### Tab `venues`

`venue`, `aliases`, `neighborhood`, `sort_order`. 122 distinct venues appeared in
2025; aliasing prevents "The Vortex" / "Vortex Repertory" splitting into two.

## Web app

`halloween/index.html` + `halloween.js`, static and client-side, no backend —
same constraints as the festival app.

**Correcting my earlier guess:** I assumed a date x venue grid. The 2025 sheet is
a date-sectioned list, so the web app follows that instead — sticky date headers
with event rows beneath, which is also what actually works on a phone for a
five-column layout.

- **List view** — the primary view. Sticky date section headers, `All Month Long`
  pinned first, event rows showing name (linked), venue, price, time, description.
- **Filters** — date, venue, and tag, multi-select, applied together, in the same
  drawer pattern as the festival app's schedule page. Filtering collapses empty
  date sections rather than leaving 34 empty banners.
- **Detail modal** — full description, ticket link, all dates for a recurring event
  ("also on..."), reusing the existing modal markup.
- **Theme toggle** — Auto / (sun) / (moon), carried over.
- **About** — carries the link to `/southbysouthwest/`.

The rotating pastel-per-date palette is the sheet's main visual signature. Carrying
it into a dark theme needs care: those pastels are backgrounds in the sheet, so in
dark mode they should become the section header/accent color rather than the row
fill. This is the one piece of design worth prototyping before committing.

## Phasing

Halloween 2026 is roughly six weeks out. Phase 2 is the part that must ship;
Phase 3 can slip without losing the season.

**Phase 1 — Freeze & restructure** — ✅ done on branch `phase-1-restructure`
- ✅ Tagged `southbysouthwest-2026-final` (local tag, pre-move state)
- ✅ Moved all 21 deployed files into `southbysouthwest/` via `git mv`
- ✅ Rewrote root-absolute refs; relative `fetch()` calls needed no change
- ✅ `CACHE_NAME` `fw-v223` → `fw-sbsw-v224`
- ✅ Added `_redirects`, festival mode active, Halloween mode commented
- ⬜ **Verify on a Cloudflare preview deploy, then merge to `main`**

**Phase 2 — Ingest & public sheet** (ships standalone)
- Finalize the feeder schema against the 2025 sheet; create the feeder
- Service account setup
- `build.py`: read → validate → `events.json` → write public sheet
- Build the public sheet template and its conditional formatting rules

**Phase 3 — Web app**
- Fork `southbysouthwest/` → `halloween/`; strip artist/rating logic
- Grid view, filters, detail modal
- Service worker and manifest at the new scope

**Phase 4 — Go live**
- Flip `_redirects` to Halloween mode
- Ship the root-scope redirect SW and the festival-page banner
- Point About at `/southbysouthwest/`

**Phase 5 — Revert (post-Halloween)**
- Flip `_redirects` back; point About at `/halloween/`
- Retire the root redirect SW
- One commit, fully reversible

## Open Questions

- **Tag vocabulary.** The draft above is keyword-derived from 2025 descriptions.
  Needs a pass by someone who remembers the events.
- **Branding.** The sheet is "Lite + Brite's Guide to ATX Halloween" — a newsletter
  product. The web app sits on festwiz.biz under FestWiz branding. Is the Halloween
  view FestWiz-branded, Lite + Brite-branded, or co-branded? This affects the header,
  the logo, and the About copy.
- **Prior years.** Several earlier spreadsheets exist. Worth importing them as an
  archive view, or is 2026 a clean start?
- **Abbreviation scrubbing.** The folder is now `southbysouthwest/`, but the
  abbreviation still appears in the deployed app's UI text, `manifest.json`, the
  page titles, `PROJECT.md`, and the public GitHub repo. If the concern is
  visibility to the organization, the folder name is the smallest of those. Say the
  word and the scrub can extend to the user-facing strings.
- **Domain.** Is `halloween.festwiz.biz` wanted, or is the path rewrite enough?
  Path is simpler and needs no DNS.
