Leave Planner (v2)  —  previously "PTOB Planner" (v1.0, archived in
PTOB-Planner-1.0\ and PTOB-Planner-1.0.zip)
============================================================
Built 2026-08-06 with Claude Code.

Leave types:
  PTOB (B) — green.  6.7692 h accrue every two weeks (posts every other
    Sunday), rising to 8.000 h after nine years of employment; cap 240 h,
    rising to 320 h at the same nine-year mark.  Hire date is editable at
    the bottom (default 2018-11-13 -> nine-year mark 2027-11-13).
    Original anchor 135.92 h on Sun 2026-07-26; click the Current balance
    tile to re-anchor from any period Sunday.
  Parental (NR) — pink.  480 h (12 weeks) per benefit year, available
    from the child's birth date (set it at the bottom), taken in 1-hour
    increments, never negative, expires one year after birth (red dotted
    line on the chart).

Neither type can be placed on weekends or company holidays (built in
through 2030 from the MITRE pay calendars).

Two interchangeable versions:

1) leave_planner.py  — Python version (recommended)
   Run:  python leave_planner.py       (or double-click "Leave Planner.bat")
   Opens http://localhost:8765.  Data: leave_data.json next to the script
   (migrates 1.0's pto_data.json automatically on first run).

2) leave_planner.html — pure HTML/JavaScript version (no Python needed)
   Double-click; runs entirely in the browser.  Data lives in the browser
   (localStorage; migrates the 1.0 planner's saved data automatically).
   Use "Backup data" / "Restore" to move data between devices/versions.
