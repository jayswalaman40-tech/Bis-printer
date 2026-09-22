# Hallmark Tag Bridge

Small local server (port **7072**) that the Chrome extension talks to. It turns
each tag into TSPL and sends it to a **TSPL-compatible thermal label printer**
(e.g. **TVSE LP 46 Neo**, TSC TE244).

## Requirements
- [Node.js](https://nodejs.org) installed.
- (Real printing only) The label printer installed and **shared** in Windows.

## First-time setup
1. Copy this `bridge/` folder to the PC.
2. Double-click **`install.bat`** (runs `npm install`).

## Choosing the printer (no code editing)
The printer name is read from **`printer.txt`** (first non-empty line that is not
a `#` comment). To point the bridge at a different printer, just edit that file —
you do not touch `bridge-server.js`.

Priority order if you prefer: `--printer "name"` argument → `HALLMARK_PRINTER`
environment variable → `printer.txt` → built-in default (`TVSELP46`).

## Run — two modes

### A) TEST MODE (no printer needed) — for trying the full flow
Double-click **`start-test.bat`** (or run `node bridge-server.js --mock`).

- A window shows: `TEST MODE — no printer needed`.
- The extension's red "Bridge not running" warning disappears after you
  reload the Weighing Desk page.
- Clicking **Print All Tags** sends every tag here; each one's TSPL is saved
  to the **`jobs/`** folder (e.g. `SN2862-0001.tspl`) and the panel shows
  `Done — N printed ✓`.
- Open any `.tspl` file to inspect exactly what would be sent to the printer.

Use this to demo and verify end-to-end before a printer is available.

### B) REAL MODE (with the label printer, e.g. TVSE LP 46 Neo)
1. **Share the printer** in Windows: Control Panel → Devices and Printers →
   right-click your printer (e.g. **TVSE LP 46 NEO(U)1**) → Printer Properties →
   Sharing → tick *Share this printer* → set the share name to a simple name
   with **no spaces**, e.g. `TVSELP46` → OK.
2. Open **`printer.txt`** and make sure it contains that exact share name.
3. Double-click **`start.bat`** (or run `node bridge-server.js`).
4. Add `start.bat` to Windows Startup (`shell:startup`) so it runs on boot.
5. Print one tag, then run **`calibrate.bat`** once so the printer learns where
   each label starts. If the position is still off, adjust `SIZE`/`GAP` at the
   top of `buildTSPL` in `bridge-server.js`.

> The TVSE LP 46 Neo uses the **TSPL** command language (the same as TSC), so the
> tags print without changing the layout code. Only the printer name and the
> label `GAP` calibration are printer-specific.

## Health check
Open `http://localhost:7072/health` →
`{"ok":true,"printer":"TVSELP46","mock":true|false}` (the `printer` value is
whatever `printer.txt` resolves to).

Keep the bridge window open while printing.
