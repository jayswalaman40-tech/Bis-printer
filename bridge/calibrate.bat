@echo off
title Hallmark Tag Bridge - Calibrate Label Gap
cd /d "%~dp0"

REM Read the share name from printer.txt (first non-empty, non-# line).
set "PRINTER="
for /f "usebackq eol=# tokens=* delims=" %%p in ("%~dp0printer.txt") do (
  if not defined PRINTER set "PRINTER=%%p"
)
if not defined PRINTER set "PRINTER=TVSELP46"

echo Sending gap calibration to "%PRINTER%"...
> "%TEMP%\hd_cal.tspl" (
  echo SIZE 100 mm, 18 mm
  echo GAP 2 mm, 0 mm
  echo DIRECTION 0
  echo GAPDETECT
)
copy /b "%TEMP%\hd_cal.tspl" "\\localhost\%PRINTER%" >nul
del "%TEMP%\hd_cal.tspl" >nul 2>&1

echo.
echo Done. The printer should feed 1-3 labels and learn where each label
echo starts. If it did NOT feed, use the FEED-button method instead:
echo   1) Turn the printer OFF
echo   2) Hold the FEED button and turn it ON
echo   3) Release when it finishes feeding a few labels
echo.
echo After calibrating, print a tag again - the position should be stable.
pause
