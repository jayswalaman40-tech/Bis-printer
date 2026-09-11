/* Hallmark Tag Bridge — port 7072. Receives a print job, builds TSPL, sends to TSC TE244. */
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 7072;
const PRINTER_NAME = 'TSC TE244';   // exact Windows printer/share name

// TEST MODE — for a full end-to-end trial without a printer.
// Enable with `node bridge-server.js --mock` (or start-test.bat), or by
// setting HALLMARK_MOCK=1. In test mode each job's TSPL is saved to ./jobs
// instead of being sent to the printer, so you can verify the whole flow
// (panel -> template -> Print All -> "Done ✓") and inspect the output.
const MOCK_MODE = process.argv.includes('--mock') || process.env.HALLMARK_MOCK === '1';
const JOBS_DIR  = path.join(__dirname, 'jobs');

app.use(cors({ origin: 'https://huid.manakonline.in' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, printer: PRINTER_NAME, mock: MOCK_MODE }));

app.post('/print-tag', async (req, res) => {
  const p = req.body;
  if (!p.huid || !p.barcode) return res.status(400).json({ ok:false, error:'huid/barcode missing' });
  try {
    const tspl = buildTSPL(p);
    if (MOCK_MODE) {
      await saveMockJob(p, tspl);
    } else {
      await sendToPrinter(tspl);
    }
    res.json({ ok:true, mock: MOCK_MODE });
  } catch (e) {
    console.error('[Bridge]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// TEST MODE: write the tag's TSPL to ./jobs/<serial|huid>.tspl and log it.
function saveMockJob(p, tspl) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (e) {}
    const safe = String(p.serial || p.huid || Date.now()).replace(/[^A-Za-z0-9._-]/g, '_');
    const file = path.join(JOBS_DIR, `${safe}.tspl`);
    fs.writeFile(file, tspl, 'ascii', (err) => {
      if (err) return reject(new Error('mock write failed: ' + err.message));
      console.log(`[Bridge][TEST] saved ${p.serial || p.huid}  ->  ${file}`);
      resolve(true);
    });
  });
}

/* 100mm x 15mm tag @203dpi (8 dots/mm). Printable strip = 65mm, laid out as:
     DETAILS  : X 0..240 dots   (0..30mm)   <- HUID / Weight / Purity
     gap       : X 240..280      (30..35mm)  <- 5mm fold gap (nothing printed)
     BARCODE  : X 280..520 dots (35..65mm)  <- Code128 + serial
   Y range     : 0..120 dots (15mm).
   Tune the two X anchors below after a test print if the strip is offset. */
const DET_X = 8;    // details block left edge  (~1mm in)
const BC_X  = 280;  // barcode block left edge  (35mm)
function buildTSPL(p) {
  const purMap = { '999':'999 24K','958':'958 23K','916':'916 22K','833':'833 20K','750':'750 18K','585':'585 14K','375':'375 9K' };
  const purity = purMap[p.purity] || p.purity || '';
  const wt = p.weight ? `${p.weight}g` : '';
  const huid = p.huid;
  const serial = p.serial || '';
  // The barcode side is a QR of the signed verification URL, so a phone scan
  // opens the detail page directly. Fall back to the HUID if no URL is sent.
  const url = p.detail_url || `HD-${huid}`;
  const D = DET_X;

  let left = '';
  if (p.template_detail === 't2') {                    // Emphasis: big HUID + centre
    left =
      `TEXT ${D},8,"1",0,1,1,"HUID"\n` +
      `TEXT ${D},24,"4",0,1,1,"${huid}"\n` +
      `TEXT ${D},70,"2",0,1,1,"${wt}  ${purity}"\n` +
      `TEXT ${D},96,"1",0,1,1,"${(p.ahc_name||'').slice(0,24)}"\n`;
  } else if (p.template_detail === 't3') {             // Grid
    left =
      `TEXT ${D},8,"1",0,1,1,"HUID"\n`      + `TEXT ${D},24,"3",0,1,1,"${huid}"\n` +
      `TEXT ${D},64,"1",0,1,1,"WT(g)"\n`    + `TEXT ${D},80,"2",0,1,1,"${p.weight||''}"\n` +
      `TEXT ${D+130},64,"1",0,1,1,"PUR"\n`  + `TEXT ${D+130},80,"2",0,1,1,"${p.purity||''}"\n`;
  } else {                                             // t1 Refined (default)
    left =
      `TEXT ${D},10,"1",0,1,1,"HUID"\n` +
      `TEXT ${D},26,"3",0,1,1,"${huid}"\n` +
      `BAR ${D},58,224,2\n` +
      `TEXT ${D},66,"1",0,1,1,"Wt"\n`       + `TEXT ${D},82,"2",0,1,1,"${wt}"\n` +
      `TEXT ${D+130},66,"1",0,1,1,"Purity"\n` + `TEXT ${D+130},82,"2",0,1,1,"${purity}"\n`;
  }

  // QR on the left of the barcode block; serial (and optional hint) to its right.
  const TX = BC_X + 100;   // text column, right of the QR
  const scanHint = (p.template_barcode === 'b2') ? `TEXT ${TX},64,"1",0,1,1,"Scan to verify"\n` : '';

  return [
    `SIZE 100 mm, 15 mm`, `GAP 2 mm, 0 mm`, `SPEED 4`, `DENSITY 8`,
    `DIRECTION 0`, `REFERENCE 0,0`, `CLS`,
    left,
    `QRCODE ${BC_X},14,M,2,A,0,"${url}"`,
    `TEXT ${TX},44,"1",0,1,1,"${serial}"`,
    scanHint,
    `PRINT 1,1`, ``
  ].join('\n');
}

function sendToPrinter(tspl) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `tag_${Date.now()}.tspl`);
    fs.writeFile(tmp, tspl, 'ascii', (werr) => {
      if (werr) return reject(new Error('temp write failed: ' + werr.message));
      exec(`copy /b "${tmp}" "\\\\localhost\\${PRINTER_NAME}"`, { shell:'cmd.exe' }, (err, so, se) => {
        fs.unlink(tmp, () => {});
        if (err) return reject(new Error(`printer error: ${err.message}\n${se}`));
        resolve(true);
      });
    });
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Hallmark Tag Bridge running on http://localhost:${PORT}  (printer: ${PRINTER_NAME})`);
  if (MOCK_MODE) {
    console.log(`*** TEST MODE — no printer needed. TSPL saved to: ${JOBS_DIR} ***`);
  }
  console.log('Keep this window open.');
});
