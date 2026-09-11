@echo off
title Hallmark Tag Bridge
cd /d "%~dp0"
if not exist "node_modules\express" (
  echo First run: installing dependencies...
  where node >nul 2>&1 || (echo Please install Node.js from https://nodejs.org & pause & exit /b 1)
  call npm install
)
node bridge-server.js
pause
