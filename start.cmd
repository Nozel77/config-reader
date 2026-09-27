@echo off
rem Double-click this file to open the editor in the browser.
rem Run "start.cmd --shortcut" once to put a double-clickable icon on the desktop.
setlocal

rem Node is the one thing this needs. Check before the window closes on an error,
rem so a machine without it gets a sentence instead of "node is not recognized".
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   CONFIG READER needs Node.js 22.13 or newer.
  echo.
  echo   "node" was not found on your PATH, so there is nothing to run.
  echo   Install it from https://nodejs.org/ ^(the LTS installer is fine^),
  echo   then close this window and double-click start.cmd again.
  echo.
  pause
  exit /b 1
)

rem The version gate lives in server.js, which names the exact missing feature.
if "%~1"=="--shortcut" (
  node "%~dp0server.js" --shortcut
) else (
  node "%~dp0server.js" --open %*
)
set code=%errorlevel%
if not "%code%"=="0" (
  echo.
  echo   CONFIG READER exited with code %code%.
  echo.
  pause
)
exit /b %code%
