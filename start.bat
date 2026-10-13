@echo off
rem Starts the Gold Replay Simulator: local server + browser.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py %* & goto :eof)
where python >nul 2>nul && (python serve.py %* & goto :eof)
echo Python 3 is required. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").
pause
