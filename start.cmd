@echo off
rem Double-click this file to open the editor in the browser.
rem Run "start.cmd --shortcut" once to put a double-clickable icon on the desktop.
if "%~1"=="--shortcut" (
  node "%~dp0server.js" --shortcut
) else (
  node "%~dp0server.js" --open %*
)
if errorlevel 1 pause
