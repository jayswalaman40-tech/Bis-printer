@echo off
echo Hallmark Tag Bridge - setup
where node >nul 2>&1 || (echo Install Node.js from https://nodejs.org & pause & exit /b 1)
call npm install
echo.
echo Next: share your label printer so the bridge can send to it.
echo   Control Panel ^> Devices and Printers ^> right-click your printer
echo   (e.g. "TVSE LP 46 NEO(U)1") ^> Printer Properties ^> Sharing ^>
echo   tick "Share this printer" ^> set share name to  TVSELP46  ^> OK
echo.
echo Then open printer.txt and make sure it has that same share name.
echo.
echo Setup done. Run start.bat to launch the bridge.
pause
