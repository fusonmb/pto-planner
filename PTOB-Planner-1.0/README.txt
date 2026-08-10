PTO Balance Planner
===================
Built 2026-08-06 with Claude Code.

Rules: 6.7692 h accrue every two weeks (balance posts every other Sunday),
rising to 8.000 h after nine years of employment; cap 240 h, rising to
320 h at the same nine-year mark. Hire date is editable at the bottom of
the app (default 2018-11-13, i.e. nine-year mark 2027-11-13).
Original anchor 135.92 h on Sun 2026-07-26. Company holidays through
2030 (from the MITRE pay calendars) are built in.

Two interchangeable versions:

1) pto_planner.py  — Python version (recommended)
   Run:  python pto_planner.py        (or double-click "PTO Planner.bat")
   Opens http://localhost:8765 in your browser.
   Data is stored in pto_data.json next to the script — plain JSON,
   easy to back up. Needs only a standard Python 3 install (no packages).
   The in-app "Save snapshot" button exports a frozen, read-only HTML
   copy of the current plan.

2) pto_planner.html — pure HTML/JavaScript version (no Python needed)
   Just double-click the file; it runs entirely in the browser.
   Data is stored in the BROWSER (localStorage), not in a file, so:
     - it is per-browser, per-machine;
     - use the "Backup data" button to download pto_data_backup.json,
       and "Restore" to load one.
   The backup JSON is the same format as pto_data.json, so data can be
   moved between the two versions freely.

Files:
  pto_planner.py    the Python program (server + UI in one file)
  pto_planner.html  the standalone HTML version
  pto_data.json     your saved plan (Python version's data)
  PTO Planner.bat   double-click launcher for the Python version
