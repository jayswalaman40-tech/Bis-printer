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

app.use(cors({ origin: 'https://huid.manakonline.in' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, printer: PRINTER_NAME }));

app.post('/print-tag', async (req, res) => {
  const p = req.body;
  if (!p.huid || !p.barcode) return res.status(400).json({ ok:false, error:'huid/barcode missing' });
  try {
    const tspl = buildTSPL(p);
    await sendToPrinter(tspl);
    res.json({ ok:true });
  } catch (e) {
    console.error('[Bridge]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* 100mm x 15mm tag @203dpi (8 dots/mm):
   Left details : X 4..250   (32.5mm)
   Fold + hole  : X 260..540
   Barcode side : X 545..795 (32.5mm)
   Y range      : 0..120 dots (15mm)
   template_detail selects the left-side layout (t1/t2/t3).
   Serial printed under the barcode. */
function buildTSPL(p) {
  const purMap = { '999':'999 24K','958':'958 23K','916':'916 22K','833':'833 20K','750':'750 18K','585':'585 14K','375':'375 9K' };
  const purity = purMap[p.purity] || p.purity || '';
  const wt = p.weight ? `${p.weight}g` : '';
  const huid = p.huid;
  const serial = p.serial || '';
  const bc = p.barcode;

  let left = '';
  if (p.template_detail === 't2') {           // Emphasis: centered
    left =
      `TEXT 10,6,"1",0,1,1,"HUID"\n` +
      `TEXT 10,22,"3",0,1,1,"${huid}"\n` +
      `TEXT 10,66,"2",0,1,1,"${wt}  ${purity}"\n`;
  } else if (p.template_detail === 't3') {    // Grid-ish
    left =
      `TEXT 6,6,"1",0,1,1,"HUID"\n`   + `TEXT 6,20,"2",0,1,1,"${huid}"\n` +
      `TEXT 6,54,"1",0,1,1,"WT(g)"\n` + `TEXT 6,68,"2",0,1,1,"${p.weight||''}"\n` +
      `TEXT 150,54,"1",0,1,1,"PUR"\n`+ `TEXT 150,68,"2",0,1,1,"${p.purity||''}"\n`;
  } else {                                     // t1 Refined (default)
    left =
      `TEXT 6,6,"2",0,1,1,"HUID ${huid}"\n` +
      `BAR 6,34,240,2\n` +
      `TEXT 6,44,"2",0,1,1,"Wt: ${wt}"\n` +
      `TEXT 6,74,"2",0,1,1,"Purity: ${purity}"\n`;
  }

  const scanHint = (p.template_barcode === 'b2') ? `TEXT 560,112,"1",0,1,1,"Scan to verify"\n` : '';

  return [
    `SIZE 100 mm, 15 mm`, `GAP 2 mm, 0 mm`, `SPEED 4`, `DENSITY 8`,
    `DIRECTION 0`, `REFERENCE 0,0`, `CLS`,
    left,
    `BARCODE 560,6,"128",70,0,0,2,2,"${bc}"`,
    `TEXT 560,84,"2",0,1,1,"${serial}"`,
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
  console.log('Keep this window open.');
});
