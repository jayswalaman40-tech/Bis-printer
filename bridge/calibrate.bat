@echo off
title Hallmark Tag Bridge - Calibrate Label Gap
cd /d "%~dp0"

REM Read the share name from printer.txt (first non-empty, non-# line).
set "PRINTER="
for /f "usebackq eol=# tokens=* delims=" %%p in ("%~dp0printer.txt") do (
  if not defined PRINTER set "PRINTER=%%p"
)
if not defined PRINTER set "PRINTER=TVSELP46"

REM Tag size from tag.txt: "small" = 82x12 mm (3 mm gap), else 100x18 mm.
set "TAG="
if exist "%~dp0tag.txt" for /f "usebackq eol=# tokens=* delims=" %%t in ("%~dp0tag.txt") do (
  if not defined TAG set "TAG=%%t"
)
set "LSIZE=100 mm, 18 mm" & set "LGAP=2 mm, 0 mm"
if /i "%TAG%"=="small" (set "LSIZE=82 mm, 12 mm" & set "LGAP=3 mm, 0 mm")

echo Sending gap calibration (%LSIZE%) to "%PRINTER%"...
> "%TEMP%\hd_cal.tspl" (
  echo SIZE %LSIZE%
  echo GAP %LGAP%
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
