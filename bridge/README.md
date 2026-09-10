# Hallmark Tag Bridge

Small local server (port **7072**) that the Chrome extension talks to. It turns
each tag into TSPL and sends it to the **TSC TE244** printer.

## Requirements
- [Node.js](https://nodejs.org) installed.
- (Real printing only) A TSC TE244 shared in Windows.

## First-time setup
1. Copy this `bridge/` folder to the PC.
2. Double-click **`install.bat`** (runs `npm install`).

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

### B) REAL MODE (with the TSC TE244)
1. Share the printer in Windows: Control Panel → Devices and Printers →
   right-click **TSC TE244** → Printer Properties → Sharing → *Share this
   printer* → note the exact share name.
2. Set `PRINTER_NAME` in `bridge-server.js` to that exact share name.
3. Double-click **`start.bat`** (or run `node bridge-server.js`).
4. Add `start.bat` to Windows Startup (`shell:startup`) so it runs on boot.

## Health check
Open `http://localhost:7072/health` → `{"ok":true,"printer":"TSC TE244","mock":true|false}`.

Keep the bridge window open while printing.
