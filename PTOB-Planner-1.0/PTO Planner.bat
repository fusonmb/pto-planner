@echo off
rem Double-click to start the PTO Balance Planner.
rem Keep this window open while using the planner; close it (or Ctrl+C) to stop.
cd /d "%~dp0"
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" pto_planner.py
pause
