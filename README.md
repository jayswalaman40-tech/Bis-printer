# Hallmark Tag Printer

A Chrome extension + local print bridge + public verification page for printing
fold-over jewellery tags on a **TSC TE244** thermal printer, driven from the BIS
MANAK portal **Weighing Desk** page.

- **Product:** Hallmark Desk (NexaCore AI)
- **Client:** BIS-recognized AHC
- **Printer:** TSC TE244 (TSPL over a local bridge on `localhost:7072`)

The full specification is in [`docs/MASTER_IMPLEMENTATION_PLAN.md`](docs/MASTER_IMPLEMENTATION_PLAN.md).
An interactive mock of the end-user flow is in
[`docs/hallmark-user-flow.html`](docs/hallmark-user-flow.html) (open in any browser).

## End-to-end flow

1. Operator opens the Weighing Desk page on the BIS MANAK portal.
2. The extension detects the page → a panel appears bottom-right.
3. Operator selects **Purity** once (applies to the whole jobcard).
4. A preview table lists every tag to verify.
5. Operator clicks **Choose template & print**.
6. Template screen: pick a details-side + barcode-side design, with a live preview.
7. **Print All Tags** → each tag's TSPL is sent to the bridge → TSC TE244 prints.
8. Later: anyone scans a tag barcode → the public detail page shows HUID, Weight, Purity.

## Repository structure

```
.
├── extension/              # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── config.js           # per-customer settings (AHC_NAME, AHC_CODE, DETAIL_BASE)
│   ├── content.js          # scrape + panel + purity + preview + template + print
│   ├── panel.css
│   └── icons/              # 16/32/48/128 px
├── bridge/                 # Local print bridge (Node.js)
│   ├── package.json
│   ├── bridge-server.js    # HTTP server → TSPL → TSC TE244
│   ├── install.bat
│   └── start.bat
├── website/                # Public verification page (Next.js)
│   ├── package.json
│   └── pages/tag/index.jsx # reads everything from the QR URL (no database)
└── docs/                   # spec + interactive flow mock
```

## Setup

### Bridge (customer PC, one time)

1. Install [Node.js](https://nodejs.org).
2. Copy the `bridge/` folder to the PC.
3. Run `install.bat` (runs `npm install` + prints printer-share instructions).
4. Share the **TSC TE244** printer in Windows; confirm the exact share name.
5. Set `PRINTER_NAME` in `bridge/bridge-server.js` to that exact name.
6. Add `start.bat` to Windows Startup (`shell:startup`).
7. Verify: `GET http://localhost:7072/health` → `{"ok":true}`.

### Extension (customer PC, one time)

1. Set `AHC_NAME`, `AHC_CODE`, and `DETAIL_BASE` in `extension/config.js`.
2. Load the extension: `chrome://extensions` → Load unpacked → select `extension/`.
3. Open the Weighing Desk page and print a test tag.

### Website (Vercel, one time)

1. Deploy the `website/` project to Vercel.
2. Verify a signed test URL renders HUID / Weight / Purity, e.g.:
   `https://hallmark-desk-five.vercel.app/tag?h=T56EMT&w=6.84&p=916&ac=Shreem+Hallmarking+Centre&dt=2026-09-11&s=4365313e8a7bb66c`

> Tag URLs are signed (`s=`). An edited or unsigned URL shows **"Invalid tag"**.
> The signing secret `SIGN_SECRET` must be identical in `extension/config.js`
> and `website/pages/tag/index.jsx`; change it per deployment.

## Serial numbers

Each tag prints a unique, deterministic serial below the barcode:

```
serial = "SN" + last4(jobcardNo) + "-" + zeroPad(tagId, 4)
example: jobcard 126388371, tag 20 → "SN8371-0020"
```

The barcode payload encodes the HUID (`HD-<HUID>`), which is globally unique.

## Out of scope

No photo/image capture, no image upload, no Supabase, no database, no login inside
the extension. The public detail page reads everything from the QR URL.
