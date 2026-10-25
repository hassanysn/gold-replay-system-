@echo off
rem Gold Replay LIVE: the replay page on your real MT5 terminal (see LIVE.md).
rem MT5 must be open and logged in, Algo Trading on, GoldLadderManager s6 on the XAUUSD chart.
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 ^(64-bit^) is required. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  goto :eof
)
%PY% -c "import MetaTrader5" >nul 2>nul
if errorlevel 1 (
  echo Installing the MetaTrader5 Python package ^(one time^)...
  %PY% -m pip install --upgrade MetaTrader5
  if errorlevel 1 (
    echo pip could not install MetaTrader5. It needs 64-bit Python 3 on Windows.
    pause
    goto :eof
  )
)
%PY% live\bridge.py %*
pause
