@echo off
title Hallmark Tag Bridge (TEST MODE - no printer)
cd /d "%~dp0"
if not exist "node_modules\express" (
  echo First run: installing dependencies...
  where node >nul 2>&1 || (echo Please install Node.js from https://nodejs.org & pause & exit /b 1)
  call npm install
)
echo.
echo Starting bridge in TEST MODE. No printer needed.
echo Each tag's TSPL will be saved into the "jobs" folder.
echo.
node bridge-server.js --mock
pause
