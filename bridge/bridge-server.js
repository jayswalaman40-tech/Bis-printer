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

// ---- Print quality (edit these if the QR is too dark/blobby or too faint) ----
// Direct-thermal bleed makes fine QR modules merge when DENSITY is too high.
// Lower QR_DENSITY for crisper, more scannable QR; raise it if print is faint.
// Range 0-15. SPEED range ~1-5 (ips); moderate speed keeps edges clean.
const QR_DENSITY = 5;          // was 6 — a touch lighter to reduce module bleed
const QR_SPEED   = 3;          // was 4 — slightly slower for cleaner edges
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

  // Layout zones (dots). The QR needs a clean white "quiet zone" all around
  // it or scanners fail — so NOTHING (no box, no bar, no text) may be drawn
  // inside the QR band. The details side is kept strictly left of DET_MAX,
  // leaving a white gap before the QR at BC_X.
  const L  = DET_X;            // details left edge (304)
  const RP = L + 150;          // purity column
  const DET_MAX = BC_X - 20;   // details must end before here (quiet zone)
  const LW = DET_MAX - L;      // width available for a left-side underline
  const QX = BC_X;             // QR left edge (560)  — clean band, no borders
  const SX = BC_X + 116;       // serial sits to the RIGHT of the QR, with a gap

  const d = p.template_detail;
  let left = '';

  // Each design varies ONLY the details (left) side. No element crosses into
  // the QR band, so every design scans and none gets clipped at the edges.
  if (d === 'd2') {            // Header emphasis: centre name + underline
    left =
      `TEXT ${L},6,"1",0,1,1,"${centre}"\n` +
      `BAR ${L},22,${LW},2\n` +
      `TEXT ${L},30,"1",0,1,1,"HUID"\n` +
      `TEXT ${L},44,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},86,"1",0,1,1,"${article}  ${wtg}  ${purity}"\n`;
  } else if (d === 'd3') {     // Big HUID emphasis
    left =
      `TEXT ${L},6,"1",0,1,1,"${centre}"\n` +
      `TEXT ${L},20,"4",0,1,1,"${huid}"\n` +
      `TEXT ${L},74,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},94,"1",0,1,1,"Wt ${wtg}   ${purity}"\n`;
  } else if (d === 'd4') {     // Labeled rows (no enclosing box)
    left =
      `TEXT ${L},6,"1",0,1,1,"${centre}"\n` +
      `BAR ${L},20,${LW},2\n` +
      `TEXT ${L},28,"1",0,1,1,"HUID"\n` + `TEXT ${L+66},26,"2",0,1,1,"${huid}"\n` +
      `TEXT ${L},52,"1",0,1,1,"ART"\n`  + `TEXT ${L+66},52,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},72,"1",0,1,1,"WT"\n`   + `TEXT ${L+66},70,"2",0,1,1,"${wtg}"\n` +
      `TEXT ${L},94,"1",0,1,1,"PUR"\n`  + `TEXT ${L+66},94,"1",0,1,1,"${purity}"\n`;
  } else if (d === 'd5') {     // Minimal clean
    left =
      `TEXT ${L},10,"1",0,1,1,"${centre}"\n` +
      `TEXT ${L},24,"4",0,1,1,"${huid}"\n` +
      `TEXT ${L},84,"1",0,1,1,"${article}   ${wtg}   ${purity}"\n`;
  } else {                     // d1 (default): the proven clean grid
    left =
      `TEXT ${L},8,"1",0,1,1,"HUID"\n` +
      `TEXT ${L},22,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},56,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},80,"1",0,1,1,"Wt ${wtg}"\n` + `TEXT ${RP},80,"1",0,1,1,"${purity}"\n` +
      `TEXT ${L},100,"1",0,1,1,"${centre}"\n`;
  }

  return [
    `SIZE 100 mm, 18 mm`, `GAP 0 mm, 0 mm`, `SPEED ${QR_SPEED}`, `DENSITY ${QR_DENSITY}`,
    `DIRECTION 0`, `REFERENCE 0,0`, `CLS`,
    left,
    // Clean QR band — no borders anywhere near it. ECC "M" adds error
    // correction so the code still decodes if thermal print bleed merges a
    // few modules (same physical size as ECC "L" for this data).
    `QRCODE ${QX},10,M,3,A,0,"${url}"`,
    `TEXT ${SX},54,"1",0,1,1,"${serial}"`,
    `TEXT ${SX},72,"1",0,1,1,"Scan QR"`,
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
