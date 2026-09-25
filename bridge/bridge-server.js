/* Hallmark Tag Bridge — port 7072. Receives a print job, builds TSPL, and sends
   it to a TSPL-compatible thermal label printer (TVSE LP 46 Neo, TSC TE244, …).
   The printer name is set in printer.txt (see resolvePrinterName below). */
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 7072;

// ---- Printer name resolution (no code edit needed per PC) ----
// The Windows printer/share name is taken from, in order:
//   1) command line:  node bridge-server.js --printer "TVSELP46"
//   2) environment:    set HALLMARK_PRINTER=TVSELP46
//   3) printer.txt     (a plain text file next to this script — first
//                       non-empty line that is not a # comment)
//   4) fallback default
// So on a new PC you just put the shared printer name in printer.txt.
function resolvePrinterName() {
  const i = process.argv.indexOf('--printer');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].trim();
  if (process.env.HALLMARK_PRINTER && process.env.HALLMARK_PRINTER.trim()) return process.env.HALLMARK_PRINTER.trim();
  try {
    const f = path.join(__dirname, 'printer.txt');
    if (fs.existsSync(f)) {
      const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim())
        .filter(s => s && !s.startsWith('#'))[0];
      if (line) return line;
    }
  } catch (e) {}
  return 'TVSELP46';   // default share name for the TVSE LP 46 Neo
}
const PRINTER_NAME = resolvePrinterName();   // exact Windows printer/share name

// ---- Tag size ----  'large' = 100x18 mm (default) | 'small' = 82x12 mm.
// Set via HALLMARK_TAG env, or a tag.txt file next to this script, else 'large'.
function resolveTag() {
  if (process.env.HALLMARK_TAG && process.env.HALLMARK_TAG.trim()) return process.env.HALLMARK_TAG.trim().toLowerCase();
  try {
    const f = path.join(__dirname, 'tag.txt');
    if (fs.existsSync(f)) {
      const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim())
        .filter(s => s && !s.startsWith('#'))[0];
      if (line) return line.toLowerCase();
    }
  } catch (e) {}
  return 'large';
}
const TAG_SIZE = resolveTag();   // 'large' or 'small'

// ---- Centre name override ----  If set, printed instead of the portal's AHC
// name. From HALLMARK_CENTRE env or centre.txt (first non-# line), else none.
function resolveCentre() {
  if (process.env.HALLMARK_CENTRE && process.env.HALLMARK_CENTRE.trim()) return process.env.HALLMARK_CENTRE.trim();
  try {
    const f = path.join(__dirname, 'centre.txt');
    if (fs.existsSync(f)) {
      const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim())
        .filter(s => s && !s.startsWith('#'))[0];
      if (line) return line;
    }
  } catch (e) {}
  return '';
}
const CENTRE_NAME = resolveCentre();

// TEST MODE — for a full end-to-end trial without a printer.
// Enable with `node bridge-server.js --mock` (or start-test.bat), or by
// setting HALLMARK_MOCK=1. In test mode each job's TSPL is saved to ./jobs
// instead of being sent to the printer, so you can verify the whole flow
// (panel -> template -> Print All -> "Done ✓") and inspect the output.
const MOCK_MODE = process.argv.includes('--mock') || process.env.HALLMARK_MOCK === '1';
const JOBS_DIR  = path.join(__dirname, 'jobs');

app.use(cors({ origin: 'https://huid.manakonline.in' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, printer: PRINTER_NAME, tag: TAG_SIZE, mock: MOCK_MODE }));

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

/* ---- SMALL TAG: 82 x 12 mm (printable 81 x 12) @203dpi = 8 dots/mm ----
   Canvas 656 x 96 dots. Printer X=0 is at the TIP of the thin tail (dandi).
   The tag is read with the tail on the LEFT and the body on the right, so
   everything prints unrotated:
     X   0..~225: thin tail (2-3 mm tall) — print NOTHING here
     X 232..422 : next to the tail — the chosen design box (d1..d5)
     X ~441     : fold line (nothing printed across it)
     X 449..636 : body end — "TAG - n", then the QR at the far end
   Designs are laid out in "tag space": u = dots from the box's left edge,
   v = dots from its top edge; X = S_X0 + u, y = S_TOP + v.
   Tune the constants below after a test print if something sits off the tag. */
const S_X0        = 232;   // printer X of the design box's left edge, just after the tail
const S_TOP       = 14;    // printer y of the design's top edge
const S_W         = 190;   // design width  (dots, ~24 mm) — ends at X 422, clear of the fold
const S_H         = 80;    // design height (dots, 10 mm)
const S_QR_RIGHT  = 636;   // QR's right edge (printer X, ~2.5 mm from the body end)
const S_TAG_MIN_X = 449;   // "TAG - n" must start after the fold (printer X)
const S_QR_MAX_H  = 66;    // max QR size (~8 mm) so it never reaches the tag edge
const S_QR_MID_Y  = 54;    // QR vertical centre, level with the design's centre
const S_GAP_MM    = 3;     // gap between tags on the roll (measured ~3 mm)

// Tag-space drawing helpers (all return TSPL lines).
const sText = (u, v, font, s) =>
  s ? `TEXT ${S_X0 + u},${S_TOP + v},"${font}",0,1,1,"${s}"\n` : '';
const sBox  = (u1, v1, u2, v2, t) => `BOX ${S_X0 + u1},${S_TOP + v1},${S_X0 + u2},${S_TOP + v2},${t}\n`;
const sBar  = (u1, v1, u2, v2) => `BAR ${S_X0 + u1},${S_TOP + v1},${u2 - u1},${v2 - v1}\n`;
const sRev  = (u1, v1, u2, v2) => `REVERSE ${S_X0 + u1},${S_TOP + v1},${u2 - u1},${v2 - v1}\n`;
// Character advance in dots, measured from a real TVSE LP 46 Neo print (font 1
// prints ~10 dots per character, not the nominal 8). Used for fitting text.
const FONT_W = { '1': 10, '2': 14, '3': 18, '4': 26 };
const fit = (s, font, width) => ('' + s).slice(0, Math.floor(width / FONT_W[font]));

// The 5 designs from the extension's template picker, sized for 190 x 80 dots.
// Every design shows Centre, HUID, Article, Weight and Purity (QR is separate).
// Fields are printed as three aligned columns — LABEL  -  value — so the dash
// sits in the same place on every row with a space either side.
const COL_DASH = 50;   // dash column, relative to the row's left edge
const COL_VAL  = 68;   // value column, relative to the row's left edge
function fieldRow(x, v, label, value, vFont) {
  const vf = vFont || '1';
  const dy = vf === '1' ? 0 : -4;                      // bigger value font sits a little higher
  return sText(x, v, '1', label) + sText(x + COL_DASH, v, '1', '-') +
    sText(x + COL_VAL, v + dy, vf, fit(value, vf, S_W - x - COL_VAL - 4));
}
function smallDesign(d, f) {
  const { huid, art, wt, pur, centre } = f;
  const L = 6, IW = S_W - 2 * L;                       // inner left + width
  if (d === 'd2') {                                     // Header bar
    return sText(L, 2, '1', fit(centre, '1', IW)) + sRev(0, 0, S_W, 16) +
      sBox(0, 0, S_W, S_H, 2) +                         // after REVERSE so its border stays black
      fieldRow(L, 23, 'HUID', huid, '2') +
      fieldRow(L, 41, 'ART', art) +
      fieldRow(L, 53, 'WT', wt) +
      fieldRow(L, 65, 'PUR', pur);
  }
  if (d === 'd3') {                                     // Big HUID
    const X = 10;
    return sBar(0, 0, 4, S_H) +
      sText(X, 1, '1', fit(centre, '1', S_W - X)) +
      sText(X, 14, '3', huid) +
      fieldRow(X, 42, 'ART', art) +
      fieldRow(X, 55, 'WT', wt) +
      fieldRow(X, 68, 'PUR', pur);
  }
  if (d === 'd4') {                                     // Labeled box
    return sBox(0, 0, S_W, S_H, 2) +
      sText(L, 3, '1', fit(centre, '1', IW)) + sBar(L, 17, S_W - L, 19) +
      fieldRow(L, 23, 'HUID', huid) +
      fieldRow(L, 37, 'ART', art) +
      fieldRow(L, 51, 'WT', wt) +
      fieldRow(L, 65, 'PUR', pur);
  }
  if (d === 'd5') {                                     // Minimal
    const X = 2;
    return sText(X, 1, '1', fit(centre, '1', S_W - 4)) +
      sText(X, 13, '3', huid) +
      sBar(X, 40, S_W - 4, 42) +
      fieldRow(X, 44, 'ART', art) +
      fieldRow(X, 56, 'WT', wt) +
      fieldRow(X, 68, 'PUR', pur);
  }
  // d1 (default): Bordered grid
  return sBox(0, 0, S_W, S_H, 2) +
    fieldRow(L, 7, 'HUID', huid, '2') +
    fieldRow(L, 26, 'ART', art) +
    fieldRow(L, 39, 'WT', wt) +
    fieldRow(L, 52, 'PUR', pur) +
    sText(L, 65, '1', fit(centre, '1', IW));
}

function buildTSPLSmall(p) {
  const clean  = (v) => ((v == null ? '' : '' + v).replace(/"/g, '').trim());
  const wn = parseFloat(p.weight);
  const w3 = isFinite(wn) ? wn.toFixed(3) : clean(p.weight);
  const f = {
    huid:   clean(p.huid),
    art:    clean(p.article).toUpperCase(),
    wt:     w3 ? `${w3}g` : '',
    pur:    clean(p.purity),                            // purity code, as in the templates
    centre: clean(CENTRE_NAME || p.ahc_name).toUpperCase(),
  };
  const url = p.detail_url || `HD-${f.huid}`;
  // Tag number: sent by the extension; older extensions only send the serial
  // (SNxxxx-0005), so fall back to its number part without leading zeros.
  const tagNo = clean(p.tag_no) ||
    (clean(p.serial).split('-').pop() || '').replace(/^0+(?=\d)/, '');

  const header =
    `SIZE 82 mm, 12 mm\nGAP ${S_GAP_MM} mm, 0 mm\nSPEED ${QR_SPEED}\nDENSITY ${QR_DENSITY}\n` +
    `DIRECTION 0\nREFERENCE 0,0\nCLS\n${smallDesign(p.template_detail, f)}`;

  // "TAG - n" just left of the QR, vertically centred on it. Uses the bigger
  // font when it fits between the fold and the QR.
  const tagText = (qrX) => {
    if (!tagNo) return '';
    const s = `TAG - ${tagNo}`;
    const end = qrX - 8;                                // text must end here
    const room = end - S_TAG_MIN_X;
    const font = s.length * FONT_W['2'] <= room ? '2' : '1';
    const h = font === '2' ? 20 : 12;
    const t = fit(s, font, room);
    return `TEXT ${end - t.length * FONT_W[font]},${S_QR_MID_Y - h / 2},"${font}",0,1,1,"${t}"\n`;
  };

  // Preferred: render the extension-supplied QR matrix as a bitmap — small
  // (2-3 dots per module, at most ~8 mm) and centred on the design's height.
  if (Array.isArray(p.qr_rows) && p.qr_rows.length) {
    const n = p.qr_rows.length;
    const scale = Math.max(2, Math.min(3, Math.floor(S_QR_MAX_H / n)));
    const bmp = qrBitmap(p.qr_rows, scale);             // unrotated = upright as read
    const qx = S_QR_RIGHT - bmp.widthPx;                // QR spans qx..S_QR_RIGHT
    const qy = Math.max(2, Math.round(S_QR_MID_Y - bmp.height / 2));
    return Buffer.concat([
      Buffer.from(header + tagText(qx), 'latin1'),
      Buffer.from(`BITMAP ${qx},${qy},${bmp.widthBytes},${bmp.height},0,`, 'latin1'),
      bmp.data,
      Buffer.from('\nPRINT 1,1\n', 'latin1'),
    ]);
  }
  // Fallback: let the printer generate the QR (cell size 2 keeps it small).
  const fqx = S_QR_RIGHT - 70;
  return Buffer.from(header + tagText(fqx) +
    `QRCODE ${fqx},${S_QR_MID_Y - 30},M,2,A,0,"${url}"\n` + 'PRINT 1,1\n', 'latin1');
}

function buildTSPL(p) {
  if (TAG_SIZE === 'small') return buildTSPLSmall(p);
  const purMap = { '999':'999 24K','958':'958 23K','916':'916 22K','833':'833 20K','750':'750 18K','585':'585 14K','375':'375 9K' };
  const clean  = (v) => ((v == null ? '' : '' + v).replace(/"/g, '').trim());
  const purity = purMap[p.purity] || clean(p.purity);
  const huid   = clean(p.huid);
  const serial = clean(p.serial);
  const article= clean(p.article).toUpperCase().slice(0, 20);
  const centre = clean(CENTRE_NAME || p.ahc_name).toUpperCase().slice(0, 28);
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

// Two ways to reach the printer:
//  1) "copy /b <file> \\localhost\<share>" — needs the printer shared and the
//     share writable; on some PCs Windows answers "Access is denied".
//  2) rawprint.ps1 — hands the bytes to the Windows print spooler as a RAW job
//     by printer name (no share, no network permission involved).
// We try 1 first; once it fails we remember that and go straight to 2.
let useSpooler = false;
function copyToShare(tmp) {
  return new Promise((resolve, reject) => {
    exec(`copy /b "${tmp}" "\\\\localhost\\${PRINTER_NAME}"`, { shell: 'cmd.exe' }, (err, so, se) => {
      if (err) return reject(new Error(((se || '') + ' ' + (so || '')).trim() || err.message));
      resolve(true);
    });
  });
}
function spoolRaw(tmp) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(__dirname, 'rawprint.ps1');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -Printer "${PRINTER_NAME}" -Path "${tmp}"`;
    exec(cmd, { timeout: 30000 }, (err, so, se) => {
      if (err) return reject(new Error(((se || '') + ' ' + (so || '')).trim() || err.message));
      if (so && so.trim()) console.log('[Bridge] spooler: ' + so.trim());
      resolve(true);
    });
  });
}
function sendToPrinter(tspl) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `tag_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.tspl`);
    // tspl may be a Buffer (contains binary BITMAP data) — write raw bytes.
    fs.writeFile(tmp, tspl, async (werr) => {
      if (werr) return reject(new Error('temp write failed: ' + werr.message));
      const done = (e) => { fs.unlink(tmp, () => {}); e ? reject(e) : resolve(true); };
      if (!useSpooler) {
        try { await copyToShare(tmp); return done(); }
        catch (e1) {
          console.warn(`[Bridge] share print failed (${e1.message.replace(/\s+/g, ' ')}) — using the Windows print spooler instead.`);
          useSpooler = true;
          try { await spoolRaw(tmp); return done(); }
          catch (e2) { useSpooler = false; return done(new Error(`printer error — share: ${e1.message} | spooler: ${e2.message}`)); }
        }
      }
      try { await spoolRaw(tmp); done(); }
      catch (e) { done(new Error('printer error (spooler): ' + e.message)); }
    });
  });
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Hallmark Tag Bridge running on http://localhost:${PORT}  (printer: ${PRINTER_NAME}, tag: ${TAG_SIZE})`);
  if (MOCK_MODE) {
    console.log(`*** TEST MODE — no printer needed. TSPL saved to: ${JOBS_DIR} ***`);
  }
  console.log('Keep this window open.');
});
// Port already taken = another bridge (often an older copy, or one started
// from Windows Startup) is still running. Say so plainly instead of a stack trace.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n*** Port ${PORT} is already in use — another Hallmark Tag Bridge is already running. ***`);
    console.error(`Check it at http://localhost:${PORT}/health`);
    console.error('To stop it: open Command Prompt and run   taskkill /F /IM node.exe');
    console.error('Also remove any old start.bat shortcut from the Startup folder (Win+R -> shell:startup).');
    console.error('Then run start.bat again.\n');
  } else {
    console.error('[Bridge] could not start:', e.message);
  }
  process.exit(1);
});
