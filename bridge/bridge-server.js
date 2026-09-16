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
// SKIP_X leaves the front of the tag (the narrow neck/head) blank; printing
// starts after it. Increase to skip more of the front, decrease to skip less.
const SKIP_X = 296;            // front blank (whole content moved 3mm toward head)
const DET_X  = SKIP_X + 8;     // details block starts just after the skip
const BC_X   = SKIP_X + 264;   // QR after the details; leaves room for the
                               // serial to sit after the QR before the tail end
function buildTSPL(p) {
  const purMap = { '999':'999 24K','958':'958 23K','916':'916 22K','833':'833 20K','750':'750 18K','585':'585 14K','375':'375 9K' };
  const clean  = (v) => ((v == null ? '' : '' + v).replace(/"/g, '').trim());
  const purity = purMap[p.purity] || clean(p.purity);
  const huid   = clean(p.huid);
  const serial = clean(p.serial);
  const article= clean(p.article).toUpperCase().slice(0, 20);
  const centre = clean(p.ahc_name).toUpperCase().slice(0, 28);
  // Weight always shown to 3 decimals.
  const wn = parseFloat(p.weight);
  const w3 = isFinite(wn) ? wn.toFixed(3) : clean(p.weight);
  const wtg = w3 ? `${w3}g` : '';
  // QR = signed verification URL (fallback to HUID).
  const url = p.detail_url || `HD-${huid}`;

  const L  = DET_X;            // details left edge
  const RP = L + 150;          // purity column
  const DIV = BC_X - 14;       // vertical divider just before the QR
  const BOXL = SKIP_X, BOXR = 776, BOXT = 4, BOXB = 114;
  const QX = BC_X, SX = BC_X + 120;   // QR and serial X

  const d = p.template_detail;
  let left = '';

  if (d === 'd2') {            // Header bar: centre name in a black strip on top
    left =
      `BAR ${BOXL},4,${DIV-BOXL},28\n` +
      `TEXT ${L},9,"1",0,1,1,"${centre}"\n` +
      `REVERSE ${BOXL},4,${DIV-BOXL},28\n` +
      `TEXT ${L},40,"1",0,1,1,"HUID"\n` +
      `TEXT ${L},54,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},90,"1",0,1,1,"${article}  ${wtg}  ${purity}"\n`;
  } else if (d === 'd3') {     // Big HUID emphasis
    left =
      `TEXT ${L},6,"1",0,1,1,"${centre}"\n` +
      `TEXT ${L},18,"4",0,1,1,"${huid}"\n` +
      `TEXT ${L},70,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},92,"1",0,1,1,"Wt ${wtg}   ${purity}"\n` +
      `BAR ${DIV},6,2,104\n`;
  } else if (d === 'd4') {     // Labeled grid inside a box
    left =
      `BOX ${BOXL},${BOXT},${BOXR},${BOXB},2\n` +
      `TEXT ${L},10,"1",0,1,1,"${centre}"\n` +
      `BAR ${L},26,236,2\n` +
      `TEXT ${L},34,"1",0,1,1,"HUID"\n`  + `TEXT ${L+70},32,"2",0,1,1,"${huid}"\n` +
      `TEXT ${L},58,"1",0,1,1,"ART"\n`   + `TEXT ${L+70},58,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},78,"1",0,1,1,"WT"\n`    + `TEXT ${L+70},76,"2",0,1,1,"${wtg}"\n` +
      `TEXT ${L},98,"1",0,1,1,"PUR"\n`   + `TEXT ${L+70},96,"2",0,1,1,"${purity}"\n` +
      `BAR ${DIV},${BOXT+2},2,${BOXB-BOXT-4}\n`;
  } else if (d === 'd5') {     // Minimal clean
    left =
      `TEXT ${L},8,"1",0,1,1,"${centre}"\n` +
      `TEXT ${L},20,"4",0,1,1,"${huid}"\n` +
      `BAR ${L},58,236,2\n` +
      `TEXT ${L},72,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},92,"2",0,1,1,"${wtg}   ${purity}"\n`;
  } else {                     // d1 (default): bordered grid
    left =
      `BOX ${BOXL},${BOXT},${BOXR},${BOXB},2\n` +
      `BAR ${DIV},${BOXT+2},2,${BOXB-BOXT-4}\n` +
      `TEXT ${L},10,"1",0,1,1,"HUID"\n` +
      `TEXT ${L},24,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},56,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},78,"1",0,1,1,"Wt ${wtg}"\n` + `TEXT ${RP},78,"1",0,1,1,"${purity}"\n` +
      `TEXT ${L},98,"1",0,1,1,"${centre}"\n`;
  }

  return [
    `SIZE 100 mm, 18 mm`, `GAP 0 mm, 0 mm`, `SPEED 4`, `DENSITY 6`,
    `DIRECTION 0`, `REFERENCE 0,0`, `CLS`,
    left,
    `QRCODE ${QX},10,L,3,A,0,"${url}"`,
    `TEXT ${SX},52,"1",0,1,1,"${serial}"`,
    `TEXT ${SX},70,"1",0,1,1,"Scan to verify"`,
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
