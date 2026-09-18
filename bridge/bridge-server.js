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
    fs.writeFile(file, tspl, (err) => {   // tspl is a Buffer (may contain binary)
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

  const d = p.template_detail;
  let left = '';

  // DETAILS side (left) — NO centre name here (it now sits beside the QR).
  // Each design varies only the details layout. Nothing crosses into the QR
  // band, so every design scans and none gets clipped at the edges.
  if (d === 'd2') {            // Underlined heading
    left =
      `TEXT ${L},8,"1",0,1,1,"HUID"\n` +
      `BAR ${L},22,${LW},2\n` +
      `TEXT ${L},30,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},70,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},90,"1",0,1,1,"${wtg}   ${purity}"\n`;
  } else if (d === 'd3') {     // Big HUID emphasis
    left =
      `TEXT ${L},10,"4",0,1,1,"${huid}"\n` +
      `TEXT ${L},70,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},90,"1",0,1,1,"Wt ${wtg}   ${purity}"\n`;
  } else if (d === 'd4') {     // Labeled rows
    left =
      `TEXT ${L},6,"1",0,1,1,"HUID"\n` + `TEXT ${L+66},4,"2",0,1,1,"${huid}"\n` +
      `BAR ${L},28,${LW},2\n` +
      `TEXT ${L},36,"1",0,1,1,"ART"\n` + `TEXT ${L+66},36,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},60,"1",0,1,1,"WT"\n`  + `TEXT ${L+66},58,"2",0,1,1,"${wtg}"\n` +
      `TEXT ${L},86,"1",0,1,1,"PUR"\n` + `TEXT ${L+66},86,"1",0,1,1,"${purity}"\n`;
  } else if (d === 'd5') {     // Minimal clean
    left =
      `TEXT ${L},16,"4",0,1,1,"${huid}"\n` +
      `TEXT ${L},80,"1",0,1,1,"${article}   ${wtg}   ${purity}"\n`;
  } else {                     // d1 (default): clean grid
    left =
      `TEXT ${L},8,"1",0,1,1,"HUID"\n` +
      `TEXT ${L},22,"3",0,1,1,"${huid}"\n` +
      `TEXT ${L},60,"1",0,1,1,"${article}"\n` +
      `TEXT ${L},84,"1",0,1,1,"Wt ${wtg}"\n` + `TEXT ${RP},84,"1",0,1,1,"${purity}"\n`;
  }

  // RIGHT column — sits to the right of the QR: centre name (wrapped) on top,
  // serial number at the bottom. Built once we know the QR's printed width.
  const wrapWords = (s, max) => {
    const words = ('' + s).split(/\s+/).filter(Boolean);
    const out = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length <= max) cur = (cur + ' ' + w).trim();
      else { if (cur) out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out;
  };
  const rightCol = (rx) => {
    const lines = wrapWords(centre, 15).slice(0, 3);
    let t = '';
    lines.forEach((ln, i) => { t += `TEXT ${rx},${8 + i * 15},"1",0,1,1,"${ln}"\n`; });
    t += `TEXT ${rx},72,"1",0,1,1,"Serial No."\n`;
    t += `TEXT ${rx},88,"1",0,1,1,"${serial}"\n`;
    return t;
  };

  const header =
    `SIZE 100 mm, 18 mm\nGAP 0 mm, 0 mm\nSPEED ${QR_SPEED}\nDENSITY ${QR_DENSITY}\n` +
    `DIRECTION 0\nREFERENCE 0,0\nCLS\n${left}`;

  // Preferred path: the extension generated the QR and sent the module matrix.
  // We render it ourselves as a bitmap so the printed QR is EXACTLY the one the
  // operator previewed (the printer no longer generates the QR).
  if (Array.isArray(p.qr_rows) && p.qr_rows.length) {
    const n = p.qr_rows.length;
    // Largest module size that still fits the tag height (~104 dots usable).
    const scale = Math.max(2, Math.min(5, Math.floor(104 / n)));
    const bmp = qrBitmap(p.qr_rows, scale);
    const qy = 8;
    const rx = QX + bmp.widthPx + 12;   // right column starts after QR + quiet zone
    return Buffer.concat([
      Buffer.from(header, 'latin1'),
      Buffer.from(`BITMAP ${QX},${qy},${bmp.widthBytes},${bmp.height},0,`, 'latin1'),
      bmp.data,
      Buffer.from('\n' + rightCol(rx) + 'PRINT 1,1\n', 'latin1'),
    ]);
  }

  // Fallback: let the printer generate the QR (older extension without qr_rows).
  const rx = QX + 99 + 12;
  return Buffer.from(header + `QRCODE ${QX},10,M,3,A,0,"${url}"\n` + rightCol(rx) + 'PRINT 1,1\n', 'latin1');
}

// Convert a QR module matrix (array of '1'/'0' strings) to a TSPL BITMAP
// payload. Each module is drawn as scale×scale dots. In TSPL BITMAP data a
// bit value of 0 = black dot (printed), 1 = white; so we start all-white
// (0xFF) and clear bits for dark modules.
function qrBitmap(rows, scale) {
  const n = rows.length;
  const widthPx = n * scale, height = n * scale;
  const widthBytes = Math.ceil(widthPx / 8);
  const data = Buffer.alloc(widthBytes * height, 0xFF);
  for (let py = 0; py < height; py++) {
    const mr = (py / scale) | 0;
    const rowStr = rows[mr];
    for (let px = 0; px < widthPx; px++) {
      if (rowStr[(px / scale) | 0] === '1') {
        const idx = py * widthBytes + (px >> 3);
        data[idx] &= ~(1 << (7 - (px & 7)));   // black dot
      }
    }
  }
  return { data, widthBytes, height, widthPx };
}

function sendToPrinter(tspl) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `tag_${Date.now()}.tspl`);
    // tspl may be a Buffer (contains binary BITMAP data) — write raw bytes.
    fs.writeFile(tmp, tspl, (werr) => {
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
