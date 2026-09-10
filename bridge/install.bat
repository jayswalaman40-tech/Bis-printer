@echo off
echo Hallmark Tag Bridge - setup
where node >nul 2>&1 || (echo Install Node.js from https://nodejs.org & pause & exit /b 1)
call npm install
echo.
echo Share the printer: Control Panel ^> Devices and Printers ^> right-click TSC TE244
echo   ^> Printer Properties ^> Sharing ^> Share this printer ^> name it "TSC TE244" ^> OK
echo.
echo Setup done. Run start.bat to launch the bridge.
pause
