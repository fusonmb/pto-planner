# Leave Planner — Google Sheets migration

Supersedes the design handoff of 2026-08-19, which was written without
reading the source.  This version records what the code actually does, the
decisions taken, and what is left.

## Decisions

| Question | Answer |
|---|---|
| Keep the Python build? | **No.** Retired 2026-08-19; in git history if needed. `leave_planner.html` (deployed as `index.html`) is the only build. |
| Sheet read-only or editable? | **Editable.** The Sheet is a real editing surface, not just a mirror, so the parse path is a first-class input. |
| Spouse access | **Editor.** Drive permissions are the permission model: Viewer = read-only, Editor = can edit. No per-row auth. |
| Holiday ownership | Code keeps the built-in list; the Sheet stores overrides (`custom` adds, `removed` tombstones), matching what the app already did. |
| Scope | `drive.file`. Narrow on purpose — see `config.example.js`. |

## What the source actually does

Read out of `index.html`, not assumed:

- **The anchor is a known balance on a known Sunday**, and the walk is seeded
  with it. It is also **forward-only**: the anchor row is the first row, and
  `applyEntry()` *rejects* any date on or before the anchor ("already
  reflected in the starting balance"). Nothing before the anchor is ever
  rendered, so no backward walk is needed.
- **Cap timing**: per period, in order — usage in the 14-day window ending on
  the posting Sunday is subtracted, the accrual is added, then the cap is
  applied. Leave taken in a period therefore frees cap headroom for that same
  period's accrual.
- **The nine-year step-up** applies from the first period Sunday on or after
  the anniversary: rate 6.7692 → 8.000, cap 240 → 320.
- **Parental** remaining is point-in-time (`birth ≤ d ≤ asOf`), clamped at
  zero, `null` before birth, `0` on or after expiry (`>=`, not `>`).
- **All date math is UTC.**
- `index.html` and `leave_planner.html` are byte-identical.

### Corrections to the original handoff

Beyond the anchor defect it flagged itself, the drafted `Code.gs` had four
more, all fixed here:

1. It accrued and capped *before* subtracting usage — the reverse of the app.
   On the test scenario that is 232.00 h instead of 236.77 h, plus a spurious
   4.77 h recorded as "lost to cap". Silent, recurring leave destruction.
2. Local-time date arithmetic against a UTC app; shifts period Sundays at
   boundaries.
3. Parental subtracted *future scheduled* hours and could go negative.
4. Parental treated the expiry day itself as still in-window.

Its §3.2 guess about cap timing was, however, correct.

## Schema

One departure from the drafted design, and the reason for it.

The draft used **one tab per leave type**, each `Date | Hours | Note |
Updated`. Two of the app's invariants do not survive that split:

- **The label is shared per day across types** (`{date: {b, nr, label}}`), so
  a per-type tab either duplicates it or loses it on round-trip.
- **The 8 h/day limit is the combined total across types**, which no single
  tab can enforce.

So leave is **one row per day**, with one column per active type:

`Leave` — `Date | PTOB | Parental | … | Label | Updated`

The columns between `Date` and `Label` are generated from the `LeaveTypes`
registry, so adding sick leave is still one registry row plus `rebuild()` —
no deploy. The per-day row also reads better by hand, which matters now that
the Sheet is an editing surface.

Other tabs:

- `Config` — key/value. **Includes `anchorBalance` alongside `anchorSunday`**;
  an anchor date without a balance is ignored rather than seeded at zero.
- `LeaveTypes` — the registry. `Model` is `biweekly` (accrues per period),
  `grant` (lump sum, optionally expiring), or `none` (recorded, no balance).
- `Holidays` — `Date | Name | Source`, source ∈ `builtin | custom | removed`.
  The `removed` tombstone is what keeps built-in holidays deletable.
- `Dashboard` — read-only mirror, rebuilt on open and daily.

## Why the Dashboard is only a mirror

Sheets API writes do not fire `onEdit`. When the web app saves, no Apps
Script runs, so the Dashboard cannot update live. It refreshes on open and
once daily.

The consequence is that the accrual walk exists twice — in the app and in
`Code.gs`. `test/codegs.test.js` is the answer to that: it runs both engines
over nine scenarios plus the golden fixture and requires identical output,
and fails on any local-time `Date` construction in `Code.gs`.

## Tests

    node test/run.js

- `calc.test.js` — 27 characterization tests. `engine.js` extracts the calc
  engine straight out of `index.html`, so they exercise shipped code.
- `codegs.test.js` — 13 tests; the two engines must agree exactly.
- `store.test.js` — 12 round-trip tests, including hand-edit hazards
  (duplicate rows for one day, numbers typed as text, malformed rows).

The golden fixture is `test/fixtures/projection.json`; regenerate
deliberately with `UPDATE_FIXTURES=1 node test/calc.test.js` and read the
diff. Both suites have been mutation-checked — deliberately breaking the
accrual rate and the cap ordering makes them go red.

## Still to do

1. **Google Cloud project** — steps are in `config.example.js`. Produces the
   client ID and API key that go in `config.js` (which must be committed;
   GitHub Pages only serves what is in the repo, and both values are public
   by design).
2. **Create the Sheet**, paste `apps-script/Code.gs`, run `setup()`.
3. ~~One-time migration of existing `localStorage` data into the Sheet.~~
   **Done.** On first connection, a Sheet with no leave rows against a
   browser that has a plan is treated as a migration, not as an instruction
   to erase: the browser's plan is pushed up. Overwriting localStorage there
   would have destroyed both copies at once — the one unrecoverable failure
   in this design. A Viewer on an empty Sheet sees their browser copy and
   nothing is written.
4. **Verify as a Viewer account** that every editing control is disabled.
   `readOnlyBlock()` gates all five mutating entry points, but this has not
   been exercised against a real Viewer session.
5. **`manifest.json` + icons** so the page installs to the phone home screen.

## Concurrent edits

With the spouse as an Editor, her hand-edits and the app's saves can collide.
The guard is the Drive `headRevisionId` check before every write, and it is
**advisory**: there is a window between the check and the write, so it
catches an edit made minutes ago, not one made in the same second. On a
conflict the app keeps the edit in localStorage, refuses to push, and asks
for a reload. Adequate for two people who rarely edit at once — do not
stretch this design to more.

## Personal data

The repository is public and serves GitHub Pages, so the app ships with **no
personal values**:

- `anchorBalance` (your PTOB balance) — Sheet `Config`, or this browser
- `hireDate` — Sheet `Config`, or this browser; without it the nine-year
  step-up simply does not apply
- `childBirthDate` — Sheet `Config`, or this browser

Only `ORIGINAL_ANCHOR` (2026-07-26) remains in code. That is the reference
Sunday for the two-week pay-period grid — a property of the MITRE pay
calendar, not of any person.

With nothing configured the app renders a setup state rather than a
misleading zero, and refuses to book leave until a starting balance exists.

Until 2026-08-19 the real balance (135.92 h) and hire date were hardcoded in
`index.html` and served publicly. They were removed from the working tree,
including the v1 archive and the test fixtures, but **they remain in git
history** — scrubbing that is a separate decision.

## Constraints preserved

No build step. No secrets in the repo. A failed API call degrades to
localStorage rather than losing edits. Weekend and holiday rules unchanged.
Parental stays whole-hour and never negative. Backup/Restore stays as the
disaster-recovery path.
