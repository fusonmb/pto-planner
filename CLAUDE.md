# Leave Planner — project context

Personal leave-planning app for mfuson (MITRE). Two interchangeable builds
kept in feature parity — **every change must be applied to BOTH**:

- `leave_planner.py` — Python 3 stdlib-only local web app (serves the same UI
  at http://localhost:8765; the entire HTML/JS page is the `PAGE` string
  inside the file). Data: `leave_data.json` next to the script.
- `leave_planner.html` — pure HTML/JS single file, same UI/logic, data in
  browser localStorage (key `leavePlannerData`). This file is also deployed
  as `index.html` on the user's GitHub Pages site (they commit it manually;
  each commit auto-redeploys). `index.html` in this folder is the
  ready-to-upload copy — keep it synced after changes.

Version 1.0 ("PTOB-Planner", single leave type) is archived in
`PTOB-Planner-1.0\` and `PTOB-Planner-1.0.zip` (also in Documents). Both v2
builds auto-migrate 1.0 data (file `pto_data.json` / localStorage key
`ptoPlannerData`). Rolling backup: `Leave-Planner-current.zip` here and in
Documents — refresh it after every change.

## Business rules (all enforced in save logic, not just UI)

PTOB (B) — green (`--leave-b`):
- Accrues 6.7692 h per two-week pay period; balance posts every other
  Sunday on the grid anchored at Sun 2026-07-26 (original anchor:
  135.92 h that day). Running balance keeps full float precision;
  rows round only for display.
- At 9 years from hire date (default 2018-11-13 → mark 2027-11-13, editable
  in footer): accrual → 8.000 h, cap 240 h → 320 h. Applied from the first
  period Sunday on/after the anniversary. Over-cap accrual is "lost".
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
- Keep both builds in parity and refresh the archives after changes.

## Gotchas

- The Python page is a raw string `PAGE` — edit it like HTML/JS, and keep
  it byte-similar to leave_planner.html where logic overlaps.
- Browser-pane testing: the user often has the app open live (their edits
  appear mid-session); file:// pages in the preview pane sometimes keep a
  stale JS context — trust live localStorage reads over in-memory STATE,
  and snapshot/restore localStorage around destructive tests.
- `python` on this machine: Python 3.12 at
  %LOCALAPPDATA%\Programs\Python\Python312 (installed via winget).
- Tests for the calc engine live in the session scratchpad (throwaway);
  re-derive from the rules above when needed.
