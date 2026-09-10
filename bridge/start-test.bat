@echo off
title Hallmark Tag Bridge (TEST MODE - no printer)
echo Starting bridge in TEST MODE. No printer needed.
echo Each tag's TSPL will be saved into the "jobs" folder.
echo.
node bridge-server.js --mock
pause
