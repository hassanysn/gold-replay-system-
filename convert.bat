@echo off
rem Converts MT5 tick exports to data\XAUUSD. Drag export files onto this file, or: convert.bat file1.csv file2.csv
cd /d "%~dp0"
if "%~1"=="" (echo Usage: drag MT5 tick export file^(s^) onto convert.bat & pause & goto :eof)
where py >nul 2>nul && (py -3 converter\convert.py %* & pause & goto :eof)
where python >nul 2>nul && (python converter\convert.py %* & pause & goto :eof)
echo Python 3 is required. Install it from https://www.python.org/downloads/
pause
