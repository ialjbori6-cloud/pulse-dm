@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo PulseDM needs Node.js 20 or newer.
  echo Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node server\index.js --open
if errorlevel 1 pause
