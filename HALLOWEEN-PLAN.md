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

**Service worker scope.** The active app is served at `/` by the rewrite but its
`service-worker.js` lives in a subdirectory, so its default scope would be that
subdirectory and it could **not** control the root page — root visitors would
silently lose offline caching. A `_headers` entry sets `Service-Worker-Allowed: /`
on the active app's worker, and its registration asks for `{ scope: '/' }`.

**Rule: only the app currently active at `/` gets that header and that scope.**
The archived app registers with its default own-directory scope. Two service
workers cannot both own `/`, so the mode flip must move the header and the
`{ scope: '/' }` registration from one app to the other — this is part of the
Phase 4 and Phase 5 checklists, not an optional extra.

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
| `tags` | | Comma-separated. Free-form — any new tag is created on ingestion. |
| `end_time` | | Optional end time, kept verbatim. |
| `status` | | `confirmed` (default) · `rumored` · `cancelled`. Cancelled rows are excluded from both exports but kept in the feeder. |
| `notes` | | Private. **Never exported.** |

### Fill-down inheritance

A cell holding a **dash** means "same as the row above". A **blank cell is
simply empty** and inherits nothing.

Repeating requires an explicit mark, deliberately. A field left out by accident
then shows up as a visible gap rather than silently carrying the previous row's
price or venue forward — which would look correct and be wrong. Intent to repeat
has to be stated.

**Ditto markers** (case-insensitive): `-`, `--`, en dash, em dash, `"`, `〃`,
`same`, `ditto`, `as above`.

Resolution rules:

1. **Blocks.** A row with a real `name` starts a block; it ends at the next row
   with a real name. A ditto marker in the name column continues the block —
   an event literally named `-` is not a real case. **Inheritance never crosses
   a block boundary**, so a blank venue on an unrelated event further down the
   sheet cannot pick up a value from a different event.
2. **Chaining.** Inheritance walks up to the nearest non-ditto value in that
   column within the block, not to the block's first row. An event can change
   venue on occurrence 2 and have occurrences 3 and 4 inherit *that* venue.
3. **`date` is never inherited.** Every row carries its own date. A row with no
   date is a hard error — otherwise a stray blank row is indistinguishable from
   an occurrence.
4. **Blank is empty.** No marker needed for a genuinely absent value — 20 events
   in 2025 had no price. A row with data but no name and no dash is an error,
   since it is ambiguous whether a new event or a repeat was meant.
5. **Year** comes from `year` in `halloween/config.json` (2026), so dates can be
   written `10/25` with no year. Changing season is a config edit, not a code
   edit.

Worked example, the hardest case from 2025 — venue *and* time change every date:

```
name                  | date      | venue            | price | time
Austin Witches Market | Sat 10/11 | Cosmic Saltillo  | free  | 6-10pm
-                     | Sun 10/12 | Radio East       | -     | 12-4pm
-                     | Sat 10/18 | Brewtorium       | -     | -
-                     | Sat 10/25 | Drinks Backyard  | -     | 6-10pm
-                     | Sun 10/26 | Far Out Lounge   | -     | -
```

Row 3's dittoed time resolves to `12-4pm` (row 2), not `6-10pm` (row 1). Price
and description are typed once and inherited by all five.

### Validating inherited values

Inheritance is **invisible in the feeder** — a blank cell looks identical whether it
means "same as above" or "I have not filled this in yet." That makes a mistake silent
rather than loud, so:

`--dry-run` prints every occurrence with all blanks **already resolved**, so the
inherited values can be eyeballed before anything reaches the public sheet. It also
reports: rows missing a date, the discovered tag list with counts and likely-typo
warnings, venues absent from the `venues` tab, and any block whose first row is
missing a required field.

### Tags — free-form, discovered at ingestion

**There is no predefined vocabulary.** Any value typed into a `tags` cell becomes a
real tag. Invent one mid-October, type it on one event, and it exists: it gets a
color, a filter chip, and a place in the web app on the next compile. Nothing has to
be registered first.

How `build.py` handles them:

- **Discovery.** Tags are collected from every occurrence after fill-down resolution.
  The full set is whatever appears in the sheet.
- **Color.** Assigned deterministically from a stable hash of the tag name into a
  fixed palette, so a given tag keeps the same color across rebuilds and across the
  season. No configuration, no drift.
- **Filter chips** in the web app are generated from the discovered set, ordered by
  frequency, so the tags you actually use surface first.

This costs nothing on the public-sheet side: the 2025 sheet colors **by date block**,
not by tag, so free-form tags never need to be mirrored into conditional formatting
rules. (That was the original reason for a controlled vocabulary; it does not apply.)

#### The one real risk: silent typos

Free-form means `haunted` and `hauntd` are both valid tags, and nothing complains.
A typo does not error — it quietly creates a second tag with one event in it and
splits a filter.

So `--dry-run` prints the **full discovered tag list with counts**, most-used first,
and flags likely duplicates as warnings: case variants (`Haunted` / `haunted`),
singular-plural pairs (`market` / `markets`), and single-character edit-distance
neighbours. Warnings never block the build — an intentional near-pair like `film` and
`films` is your call, not the tool's. They just make the typo visible before the
public sheet sees it.

#### Optional `tags` tab — overrides only

Not required, and empty by default. Add a row only to override what discovery
guessed for a specific tag:

`tag`, `display_name` (e.g. `drag-burlesque` → "Drag & Burlesque"), `color` (hex,
to pin one you care about), `sort_order` (to force a tag to the front of the chips).

Any tag absent from this tab behaves exactly as described above.

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
- Move `Service-Worker-Allowed: /` in `_headers` to the Halloween worker, and move
  the `{ scope: '/' }` registration with it; festival app reverts to default scope
- Ship the root-scope redirect SW and the festival-page banner
- Point About at `/southbysouthwest/`

**Phase 5 — Revert (post-Halloween)**
- Flip `_redirects` back; point About at `/halloween/`
- Move the `_headers` scope grant and `{ scope: '/' }` registration back
- Retire the root redirect SW
- One commit, fully reversible

## Decided

- **Tags are free-form**, created on ingestion, no predefinition. See above.
- **Branding: co-branded.** FestWiz logo and chrome; "Lite + Brite's Guide to ATX
  Halloween" as the page title, with a newsletter subscribe link carried over from
  the sheet's promo row.
- **PWA installs stay on the festival app** after the mode flip.
- **One service account** reads the feeder and writes the public sheet.
- **No subdomain.** festwiz.biz already fronts festwiz.pages.dev; the path
  rewrite is sufficient and needs no DNS work.
- **2026 is a clean start.** Earlier years' spreadsheets stay available as a
  resource but are not imported.

### Abbreviation scrubbing — audited and complete

The UI was already clean: page titles and `manifest.json` say only "FestWiz".
Three code comments were the only safe changes and have been made. What remains,
and why each stays:

| Where | Count | Why it stays |
|---|---|---|
| `sxsw2026_*` localStorage keys | ~10 keys | Renaming silently erases every user's ratings, notes, tiers, agenda and theme. See below. |
| `schedule.sxsw.com` / `images.sxsw.com` URLs | 3,478 | Real external URLs. |
| Third-party event names in `shows.json` | ~66 | Other organizations' event titles — "Take Action x SXSW", "Billboard Presents: The Stage at SXSW", "SXSW London". Rewriting them would misname real events and break search. One artist bio quotes the abbreviation in their own copy. |

**On the storage keys:** localStorage is scoped per *origin*, not per path, so the
move into `southbysouthwest/` did not disturb existing user data. Renaming the keys
would. The natural moment to change them is 2027 prep, when the `2026` suffix has to
change anyway and there is no live data worth preserving — free then, risky now.
A migration shim could do it sooner if wanted.

## Where things stand (2026-09-21)

**Done and live.** Phase 1 merged to `main` and deployed. The festival app runs
at `/southbysouthwest/`, served at `/` by the `_redirects` rewrite, with the
`_headers` service-worker scope grant. Verified on a preview deploy and then in
production; Brian confirmed festwiz.biz resolves and his ratings survived the
move. Tag `southbysouthwest-2026-final` is pushed to GitHub.

**Ingest works end to end (read half).** `halloween/build.py` reads the feeder
sheet live via gspread, resolves ditto inheritance, validates, and writes
`events.json` / `venues.json` / `tags.json`.

```bash
python3 halloween/build.py --dry-run          # validate, write nothing
python3 halloween/build.py                    # write the JSON
python3 halloween/build.py --csv <file>       # read an export instead
```

Validated two ways: the live feeder's 15 test rows resolve correctly (4 events,
2 recurring), and a fixture generated from the 2025 guide reconstructs all 239
occurrences exactly, field for field.

**Feeder columns**, all mapping: Event name, URL, Date, Start time, End time,
Location, Price, Tags, Description, Status, Notes.

**Credentials** live in `credentials/` (gitignored). Service account is
`agent-380@l-and-b-halloween-2026.iam.gserviceaccount.com`. Both sheets are
shared with it — feeder as Viewer, public sheet as Editor. Sheet ids are in
`halloween/config.json`.

### Next, in order

1. **Read the public sheet's formatting.** Access is confirmed (360 rows read).
   Still unexamined: the rotating pastel-per-date fills, black section banners,
   frozen panes, and the hyperlinks on event names — CSV export flattens all of
   it. This determines whether the writer can be values-only against a template
   with conditional-formatting rules, or has to emit cell formatting itself.
   The open sub-question is the 34 date-section banner rows: since the script
   regenerates the whole value range each compile, they cannot be hand-formatted
   per row.
2. **Write half of the pipeline** — push resolved occurrences to the public sheet.
3. **Phase 3, the web app** — `halloween/index.html` reading `events.json`.

### Undecided

- **Age as its own column vs. a tag.** Brian currently tags `13+`, `18+`,
  `all ages`. Recommendation on the table: a dedicated column, because age is
  ordinal and tags are not — a column supports "suitable for a 14-year-old"
  (everything at or below a threshold), enforces one value per event, keeps the
  tag chips about event *kind*, and can be validated. Cheap now, expensive once
  the feeder has 200 rows. Awaiting Brian's call.
- **`halloween/build.py` is tracked**, so in Halloween mode the rewrite would
  serve it at `/build.py`. No secrets in it, but it could move to a `tools/`
  directory that 404s in both modes.

## Open Questions

_(none currently open.)_
