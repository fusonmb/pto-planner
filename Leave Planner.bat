@echo off
rem Double-click to start the Leave Planner (PTOB + parental leave).
rem Keep this window open while using the planner; close it (or Ctrl+C) to stop.
cd /d "%~dp0"
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" leave_planner.py
pause
