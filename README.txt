Leave Planner (v2)  —  previously "PTOB Planner" (v1.0, archived in
PTOB-Planner-1.0\ and PTOB-Planner-1.0.zip)
============================================================
Built 2026-08-06 with Claude Code.

Leave types:
  PTOB (B) — green.  6.7692 h accrue every two weeks (posts every other
    Sunday), rising to 8.000 h after nine years of employment; cap 240 h,
    rising to 320 h at the same nine-year mark.  Set your hire date at the
    bottom of the page (there is no default; without it the step-up is not
    applied).  Click the Current balance tile to set your balance on any
    pay-period Sunday.  Your balance, hire date and child's birth date are
    yours: they live in your browser or your private Google Sheet, never in
    this repository.
  Parental (NR) — pink.  480 h (12 weeks) per benefit year, available
    from the child's birth date (set it at the bottom), taken in 1-hour
    increments, never negative, expires one year after birth (red dotted
    line on the chart).

Neither type can be placed on weekends or company holidays (built in
through 2030 from the MITRE pay calendars).

One version:

  leave_planner.html — pure HTML/JavaScript, no dependencies.  Double-click
  it, or use the deployed copy at https://fusonmb.github.io/pto-planner/
  (index.html is the same file).  Data lives in the browser (localStorage;
  migrates the 1.0 planner's saved data automatically).  "Backup data" /
  "Restore" move data between devices.

  The Python version (leave_planner.py, "Leave Planner.bat") was retired on
  2026-08-19 — it is in git history if it is ever wanted again.  The HTML
  build is now the only one, and is moving to a Google Sheets backend so the
  plan follows the user across devices instead of living in one browser.
