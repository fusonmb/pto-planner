# Leave Planner — project context

Repo: https://github.com/fusonmb/pto-planner (PUBLIC — it also serves the
GitHub Pages deployment of index.html; never commit pto_data.json /
leave_data.json / backups, they're gitignored because they encode the
user's leave plan and child's birth date). Pull before working, push after.
**Test fixtures must use invented values, never the user's real balance,
hire date or child's birth date** — a screenshot or a live Config tab is a
tempting source and it lands straight in a public repo. (Happened once,
2026-08-21; the values are still in history, left there deliberately.)

Personal leave-planning app for mfuson (MITRE). **One build** as of
2026-08-19:

- `leave_planner.html` — pure HTML/JS single file. Deployed as `index.html`
  on the user's GitHub Pages site; pushing to `main` is the deploy, no
  manual upload. `index.html` is a byte-identical copy — keep the two in
  sync after every change (`md5sum index.html leave_planner.html`).
- `sheets-store.js` — Google Sheets storage. Hydrates a cache once, then
  serves `loadData()` synchronously and flushes writes to the Sheet behind
  the UI, so the calc engine stays synchronous. localStorage is written on
  every save and is the fallback when the Sheet is unreachable or absent.
- `config.js` — client ID + API key (see `config.example.js`). **Must be
  committed** — Pages only serves what's in the repo, and both values are
  public by design. Without it the app silently stays on localStorage.
- `apps-script/Code.gs` — lives in the Sheet. Builds the tabs and refreshes
  the read-only Dashboard. Contains a second copy of the accrual walk;
  `test/codegs.test.js` forces the two to agree.
- `docs/HANDOFF.md` — the migration's design record and remaining work.
- `leave_planner.py` (Python local server) was **retired**; it is in git
  history if ever needed. The old "keep both builds in parity" rule is gone.

## Tests

`node test/run.js` — all three suites (52 tests). Individually:
`calc.test.js` — characterization tests for the calc engine.
`test/engine.js` extracts the engine straight out of `index.html` and runs it
under node, so the tests always exercise the shipped code. A golden
projection fixture lives in `test/fixtures/`; regenerate deliberately with
`UPDATE_FIXTURES=1 node test/calc.test.js` and review the diff. **Run these
before and after any change to the math or the storage layer.**

Version 1.0 ("PTOB-Planner", single leave type) is archived in
`PTOB-Planner-1.0\` and `PTOB-Planner-1.0.zip` (also in Documents). Both v2
builds auto-migrate 1.0 data (file `pto_data.json` / localStorage key
`ptoPlannerData`). Rolling backup: `Leave-Planner-current.zip` here and in
Documents — refresh it after every change.

## Business rules (all enforced in save logic, not just UI)

PTOB (B) — green (`--leave-b`):
- Accrues 6.7692 h per two-week pay period; balance posts every other
  Sunday on the grid anchored at Sun 2026-07-26. That grid date is a pay-
  calendar fact and ships in the code; the **balance** on it is personal and
  does not — it lives in the Sheet's `Config` (`anchorBalance`) or in this
  browser. Running balance keeps full float precision; rows round only for
  display.
- At 9 years from hire date (set in the footer or the Sheet's `Config`;
  there is **no default** — the step-up simply does not apply until one is
  set): accrual → 8.000 h, cap 240 h → 320 h. Applied from the first period
  Sunday on/after the anniversary. Over-cap accrual is "lost".
- Balance may go negative (flagged red "overdrawn").
- Current balance is click-editable on its tile, re-anchorable to any past
  period Sunday (validated against the 14-day grid).

Parental (NR) — pink (`--leave-nr`):
- 480 h (12 weeks × 40) per benefit year, from child's birth date (footer,
  optional — feature off when unset) until exactly one year after birth
  (red dotted vertical on the chart marks expiry).
- Whole hours only (1-h increments). Can NEVER go negative.
- Bulk saves fill days in date order until pool/room runs out, skip days
  outside the window, and report notes — they don't hard-fail unless
  nothing can be booked.

Shared:
- A day holds max 8 h combined (B + NR); saves clamp to remaining room,
  skip full days, with notes.
- Weekends and holidays NEVER receive leave (auto-skipped; single-day
  attempts rejected). Company holidays 2026–2030 are hardcoded
  (transcribed from MITRE pay-calendar PDFs; note: the 2030 calendar marks
  Mon Jan 14 as the holiday even though MLK 2030 is Jan 21 — transcribed
  as printed). Custom holidays add/remove via editor; removals of builtins
  tracked in `removedHolidays`.
- Entries: `{date: {b: hours, nr: hours, label}}`. Label shared per day.
- Clear removes the whole day (both types + label).

## UI conventions

- Dark theme default (localStorage `ptoTheme`), Theme toggle; Units toggle
  hours↔days (8 h = 1 d, display-only, math always in hours; localStorage
  `ptoUnits`).
- Calendar: drag to select range (desktop); long-press-then-tap on touch.
  Editor: h/day box pre-filled with 8, label field gets focus on desktop
  (no autofocus on touch — keyboard pop-up is unwanted). Buttons:
  Save (PTOB) green, Save (Parent) pink, Clear. Enter = Save PTOB.
- Calendar shading alternates by pay period (NOT weekends); periods end on
  grid Sundays; out-of-month cells keep shading, only the date number dims.
  Period Sundays show "bal N" in-cell.
- Chart: green PTOB line + pink parental-remaining line, both with
  clickable points that jump the calendar to that period Sunday; stepped
  dashed cap line; month-boundary x-ticks with year-rollover labels; hover
  tooltips (per-Sunday breakdown incl. parental lines in pink).
- Mobile (≤700px / coarse pointer): explanatory text hidden, tiles moved to
  bottom, shorter chart, bigger tap targets. Desktop must stay unchanged
  by mobile tweaks.
- Informational save-notes are suppressed on small screens; real errors
  always show.

## User preferences (important)

- Interpret the intent, not the literal ask; sanity-check details that
  would defeat the purpose, implement the sensible reading, and say so.
  (Confirmed pattern: they once gave their 9-year anniversary when asked
  for a "hire date".)
- Iterate and verify in the browser; don't stop at the literal request.
- Keep `index.html` and `leave_planner.html` byte-identical, and refresh the
  archives after changes.

## Google Sheets backend

- The Sheet is **editable by hand**, so the parse path is a real input, not
  just a mirror: duplicate rows for one day, numbers typed as text, and
  malformed rows all have to survive `hydrate()`.
- Leave is **one row per day** with a column per active type — not a tab per
  type. The label is shared per day and the 8 h limit is the combined total,
  and neither survives being split across tabs.
- Sheets API writes do NOT fire `onEdit`, so nothing in `Code.gs` runs when
  the app saves. The Dashboard refreshes on open and daily.
- `Config` needs `anchorBalance` as well as `anchorSunday`; an anchor date
  with no balance is ignored rather than seeded at zero.
- Drive permissions are the whole permission model. `readOnlyBlock()` gates
  all five mutating entry points so a Viewer cannot write through any path.

## Working locally and on the web

GitHub is the single source of truth; both surfaces clone from it.

- **Push before you leave, pull before you start.** A Claude Code web session
  clones the *remote*, so it cannot see local commits you have not pushed.
- **Deploying is just pushing to `main`.** GitHub Pages serves `index.html`
  from `main` and rebuilds in well under a minute. There is no build step
  and no manual upload.
- **Local pushes work** through Git Credential Manager (VSCode extension or
  a terminal). **Web-session pushes needed `/web-setup`** to sync a `gh`
  token to the Claude account — a cloud session otherwise gets a read-only
  credential and every push fails with 403. If a web session cannot push,
  bring the branch here (`git bundle`, or `claude --teleport` once the
  branch exists on the remote) and push from this machine.
- **Leave data never syncs through git** (`leave_data.json` and localStorage
  are gitignored). That is what the Google Sheets backend is for.

## Toolchain on this machine

- Node 24 LTS at `C:\Program Files
odejs` (winget `OpenJS.NodeJS.LTS`) —
  needed for `node test/run.js`.
- GitHub CLI at `C:\Program Files\GitHub CLI` (winget `GitHub.cli`).
- Python 3.12 at `%LOCALAPPDATA%\Programs\Python\Python312`.

## Gotchas

- Browser-pane testing: the user often has the app open live (their edits
  appear mid-session); file:// pages in the preview pane sometimes keep a
  stale JS context — trust live localStorage reads over in-memory STATE,
  and snapshot/restore localStorage around destructive tests.
- The calc engine sits between the `calc engine` and `UI` banner comments in
  the `<script>` block. `test/engine.js` finds it by those markers and by the
  names of five date helpers declared just below the UI banner — renaming a
  marker or a helper breaks extraction loudly, which is intended.
