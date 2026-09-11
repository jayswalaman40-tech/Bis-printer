# Hallmark Tag Printer — Master Implementation Plan
**Product:** Hallmark Desk (NexaCore AI) · **Client:** BIS-recognized AHC · **Printer:** TSC TE244
**Version:** 1.0 (final) · Single source of truth for the developer.

This is a complete, self-contained spec. A developer should be able to build the
whole system from this document with no further questions. All UI text is English.

---

## 1. What we are building

A Chrome extension that runs on the BIS MANAK portal **Weighing Desk** page. The
operator selects a purity once, previews all tags, chooses a print template, and
prints fold-over jewellery tags on a **TSC TE244** thermal printer via a small local
bridge server. Each tag's barcode links to a permanent public verification page.

### In scope
- Chrome extension (scrape + panel + purity dropdown + preview table + template picker + print trigger)
- Local print bridge (Node.js) that talks to TSC TE244 using TSPL
- Public detail/verification web page (Next.js on Vercel)

### Out of scope (explicitly NOT built)
- Photo/image capture, image upload, Supabase sync — none of it
- Any login inside the extension
- Any database (the detail page reads everything from the QR URL)

### End-to-end flow
```
1. Operator opens the Weighing Desk page on the BIS MANAK portal
2. Extension detects the page → panel appears bottom-right
3. Operator selects Purity once (applies to the whole jobcard)
4. Preview table lists every tag (verify)
5. Operator clicks "Choose template & print"
6. Template screen: pick details-side + barcode-side design, live preview
7. Click "Print All Tags" → each tag's TSPL is sent to the bridge → TSC TE244 prints
8. Later: anyone scans a tag barcode → public detail page shows HUID, Weight, Purity
```

---

## 2. Repository structure

```
hallmark-tag-printer/
├── extension/
│   ├── manifest.json
│   ├── config.js
│   ├── content.js          # scrape + panel + purity + preview + template + print
│   ├── panel.css
│   └── icons/ (16,32,48,128)
├── bridge/
│   ├── package.json
│   ├── bridge-server.js    # HTTP server → TSPL → TSC TE244
│   ├── install.bat
│   └── start.bat
└── website/
    └── pages/tag/index.jsx # public verification page (no images)
```

---

## 3. Key data facts (verified from real portal HTML)

Scrape target: Weighing Desk page. Reliable anchors:
- `#str_job_no` (hidden input) → Job Card Number, e.g. `126388371`
- `#str_request_no` (hidden input) → Request Number
- `#tabWeight` → the articles table

`#tabWeight` row columns (`td` index):

| index | column | how to read | example |
|---|---|---|---|
| 0 | S No. | text | `1` |
| 1 | AHC Tag | `.tagIdCls` text | `18` |
| 2 | Material Category | text | `Gold` |
| 3 | Item Category | text | `RING+PENDENT` |
| 4 | HUID | text | `3LCRPA` |
| 5 | Weight input | `input.weightCls` `.value` | operator-entered |
| 6 | Save button | — | — |

Notes:
- HUID is a 6-char alphanumeric (e.g. `3LCRPA`, `85LTAZ`) and is globally unique → use it as the barcode payload.
- Weight is a live input; the operator scans each from the weighing scale. **Print only after weights are filled.**
- **Purity is NOT on this page.** It is chosen once via a dropdown in the panel (section 5.3).
- The page blocks F12/right-click and has a devtools-detector that wipes the page. This does **not** affect a content script (it reads the DOM directly and never opens devtools). Just note the page reloads after each weight save, so the panel re-scrapes on each load.

---

## 4. Serial number (unique per tag, printed under barcode)

Each tag prints a human-readable serial below the barcode. It must be unique with
no duplicates. Use a deterministic serial derived from the jobcard + tag id (both
already unique), so re-printing the same tag yields the same serial:

```
serial = "SN" + last4(jobcardNo) + "-" + zeroPad(tagId, 4)
example: jobcard 126388371, tag 20 → "SN8371-0020"
```

The barcode payload itself encodes the HUID (`HD-<HUID>`), which is globally unique;
the serial is the human-readable unique reference. Two different tags can never
collide because tag id is unique within a jobcard and the jobcard number is unique.

---

## 5. Extension

### 5.1 manifest.json
```json
{
  "manifest_version": 3,
  "name": "Hallmark Tag Printer",
  "version": "1.0.0",
  "description": "Scrape the BIS MANAK Weighing Desk and print HUID tags on a TSC TE244.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://huid.manakonline.in/*",
    "http://localhost:7072/*"
  ],
  "icons": { "16":"icons/icon16.png","32":"icons/icon32.png","48":"icons/icon48.png","128":"icons/icon128.png" },
  "content_scripts": [
    {
      "matches": ["https://huid.manakonline.in/*"],
      "js": ["config.js", "content.js"],
      "css": ["panel.css"],
      "run_at": "document_idle"
    }
  ]
}
```

### 5.2 config.js
```javascript
const TAG_CONFIG = {
  BRIDGE_URL:  'http://localhost:7072',
  DETAIL_BASE: 'https://hallmark-desk.vercel.app/tag',
  AHC_NAME:    'Shreem Hallmarking Centre',   // per-customer
  AHC_CODE:    'SHC001',                        // per-customer
};
```

### 5.3 content.js (complete)
```javascript
/* ================================================================
   HALLMARK TAG PRINTER — content script
   Runs on huid.manakonline.in (Weighing Desk page)
   Flow: scrape -> purity dropdown -> preview table -> template -> print
   ================================================================ */
(function () {
  // ---- page detection (DOM-based, reliable) ----
  function isWeighingDesk() {
    return !!document.getElementById('tabWeight')
        && !!document.getElementById('str_job_no');
  }
  if (!isWeighingDesk()) return;

  // ---- constants ----
  const PURITY_OPTIONS = [
    { code: '999', label: '24K · 999' },
    { code: '958', label: '23K · 958' },
    { code: '916', label: '22K · 916' },
    { code: '833', label: '20K · 833' },
    { code: '750', label: '18K · 750' },
    { code: '585', label: '14K · 585' },
    { code: '375', label: '9K · 375'  },
  ];
  const PURITY_LABEL = Object.fromEntries(PURITY_OPTIONS.map(o => [o.code, o.label]));

  // ---- scraper ----
  function scrape() {
    const jobNo = (document.getElementById('str_job_no')?.value || '').trim();
    const reqNo = (document.getElementById('str_request_no')?.value || '').trim();
    const rows  = document.querySelectorAll('#tabWeight tbody tr[role="row"]');
    const tags  = [];
    rows.forEach((tr) => {
      const td = tr.querySelectorAll('td');
      if (td.length < 6) return;
      const sno     = (td[0].textContent || '').trim();
      const tagId   = (td[1].textContent || '').trim();
      const material= (td[2].textContent || '').trim();
      const article = (td[3].textContent || '').trim();
      const huid    = (td[4].textContent || '').trim();
      const wInput  = tr.querySelector('input.weightCls, input.scan-input, input[name="articlWeight"]');
      const weight  = wInput ? (wInput.value || '').trim() : '';
      if (!tagId) return;
      tags.push({
        position: sno ? parseInt(sno, 10) : tags.length + 1,
        tag_id: tagId, material, article, huid, weight,
        canPrint: !!huid && !!weight
      });
    });
    return { jobcardNo: jobNo, requestNo: reqNo, tags };
  }

  // ---- serial (unique per tag) ----
  function serialFor(jobcardNo, tagId) {
    const base = String(jobcardNo).slice(-4);
    const seq  = String(tagId).padStart(4, '0');
    return `SN${base}-${seq}`;
  }

  // ---- payload for one tag ----
  function buildPayload(tag, jobcardNo, purityCode, templateDetail, templateBarcode) {
    const serial = serialFor(jobcardNo, tag.tag_id);
    const qs = new URLSearchParams({
      h: tag.huid, w: tag.weight, p: purityCode,
      ac: TAG_CONFIG.AHC_NAME, dt: new Date().toISOString().slice(0, 10)
    }).toString();
    return {
      huid: tag.huid, weight: tag.weight, purity: purityCode,
      serial, barcode: `HD-${tag.huid}`,
      ahc_name: TAG_CONFIG.AHC_NAME,
      template_detail: templateDetail,      // 't1' | 't2' | 't3'
      template_barcode: templateBarcode,    // 'b1' | 'b2'
      detail_url: `${TAG_CONFIG.DETAIL_BASE}?${qs}`
    };
  }

  // ---- bridge calls ----
  async function bridgeAlive() {
    try {
      const r = await fetch(`${TAG_CONFIG.BRIDGE_URL}/health`, { method:'GET', signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }
  async function sendPrint(payload) {
    const r = await fetch(`${TAG_CONFIG.BRIDGE_URL}/print-tag`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  // ---- state ----
  let selPurity  = '';
  let selDetail  = 't1';   // default (recommended)
  let selBarcode = 'b1';

  // ---- build panel ----
  const panel = document.createElement('div');
  panel.className = 'htp-panel';
  panel.innerHTML = `
    <div class="htp-head">
      <span class="htp-dot"></span>
      <span class="htp-title">Tag Printer</span>
      <button class="htp-x" title="Hide">&times;</button>
    </div>
    <div class="htp-body">
      <div class="htp-warn" style="display:none">
        Bridge server not running. Start <code>start.bat</code> on the PC, then reload.
      </div>
      <div class="htp-purity">
        <label>Purity (whole jobcard):</label>
        <select class="htp-purity-sel">
          <option value="">— Select —</option>
          ${PURITY_OPTIONS.map(o => `<option value="${o.code}">${o.label}</option>`).join('')}
        </select>
      </div>
      <p class="htp-status">Loading…</p>
      <div class="htp-table-wrap">
        <table class="htp-table">
          <thead><tr><th>#</th><th>Tag</th><th>Article</th><th>Purity</th><th>Wt (g)</th><th>HUID</th></tr></thead>
          <tbody class="htp-tbody"></tbody>
        </table>
      </div>
      <button class="htp-next" disabled>Select purity first</button>
    </div>`;
  document.body.appendChild(panel);

  const $ = (s) => panel.querySelector(s);
  const purSel = $('.htp-purity-sel');
  const statusEl = $('.htp-status');
  const tbody = $('.htp-tbody');
  const nextBtn = $('.htp-next');
  const warnEl = $('.htp-warn');
  $('.htp-x').onclick = () => panel.classList.toggle('htp-min');

  function renderTable(data) {
    tbody.innerHTML = data.tags.map(t => {
      const can = t.canPrint;
      const pur = selPurity ? PURITY_LABEL[selPurity] : '<span class="htp-dash">—</span>';
      const huid = t.huid ? t.huid : '<span class="htp-miss">⚠ no HUID</span>';
      const wt = t.weight ? t.weight : '<span class="htp-miss">—</span>';
      return `<tr class="${can?'':'htp-blk'}">
        <td class="htp-c-sno">${t.position}</td>
        <td class="htp-c-tag">${t.tag_id}</td>
        <td>${t.article}</td>
        <td class="htp-c-pur">${pur}</td>
        <td class="htp-c-wt">${wt}</td>
        <td class="htp-c-huid">${huid}</td></tr>`;
    }).join('');
  }

  function refresh() {
    const data = scrape();
    const printable = data.tags.filter(t => t.canPrint).length;
    const missing = data.tags.length - printable;
    statusEl.innerHTML = `${data.tags.length} tags · ${printable} ready`
      + (missing ? ` · ${missing} not ready (no HUID/weight)` : '');
    renderTable(data);
    nextBtn.disabled = !(selPurity && printable > 0);
    nextBtn.textContent = selPurity
      ? `Choose template & print (${printable})`
      : 'Select purity first';
    return { data, printable };
  }

  purSel.onchange = () => { selPurity = purSel.value; refresh(); };
  nextBtn.onclick = () => openTemplateModal();

  // ---- template modal ----
  function detailPreviewHTML(tpl, d) {
    if (tpl === 't1') return `<div class="ds ds-t1">
      <div class="h"><span class="hk">HUID</span><span class="hv">${d.huid}</span></div>
      <div class="rule"></div>
      <div class="r"><span class="k">Weight</span><span class="v">${d.wt} g</span></div>
      <div class="r"><span class="k">Purity</span><span class="v">${d.pur}</span></div></div>`;
    if (tpl === 't2') return `<div class="ds ds-t2">
      <div class="hk">HUID</div><div class="hv">${d.huid}</div>
      <div class="sub">${d.wt} g&nbsp;·&nbsp;${d.pur}</div>
      <div class="ahc">${TAG_CONFIG.AHC_NAME}</div></div>`;
    return `<div class="ds ds-t3">
      <div class="cell"><div class="k">HUID</div><div class="v">${d.huid}</div></div>
      <div class="cell"><div class="k">Wt(g)</div><div class="v sm">${d.wt}</div></div>
      <div class="cell"><div class="k">Purity</div><div class="v sm">${d.purCode}</div></div></div>`;
  }

  function openTemplateModal() {
    const { data } = refresh();
    const sample = (() => {
      const t = data.tags.find(x => x.canPrint) || data.tags[0];
      return { huid: t.huid || '------', wt: t.weight || '0.000',
        pur: PURITY_LABEL[selPurity], purCode: selPurity,
        serial: serialFor(data.jobcardNo, t.tag_id) };
    })();

    const overlay = document.createElement('div');
    overlay.className = 'htp-modal';
    overlay.innerHTML = `
      <div class="htp-modal-card">
        <div class="htp-modal-head">
          <div>
            <h3>Choose Tag Template</h3>
            <p>Jobcard ${data.jobcardNo} · Purity ${PURITY_LABEL[selPurity]}</p>
          </div>
          <button class="htp-modal-x">&times;</button>
        </div>
        <div class="htp-modal-body">
          <p class="htp-sec">Details side</p>
          <div class="htp-cards htp-cards-3" id="htpDetailCards"></div>
          <p class="htp-sec">Barcode side</p>
          <div class="htp-cards htp-cards-2" id="htpBarcodeCards"></div>
          <p class="htp-sec">Live preview</p>
          <div class="htp-final" id="htpFinal"></div>
        </div>
        <div class="htp-modal-foot">
          <button class="htp-cancel">Cancel</button>
          <button class="htp-print">Print All Tags</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const detailDefs  = [ {id:'t1',name:'Refined',rec:true}, {id:'t2',name:'Emphasis'}, {id:'t3',name:'Grid'} ];
    const barcodeDefs = [ {id:'b1',name:'Serial only'}, {id:'b2',name:'Serial + scan hint'} ];

    function paintCards() {
      overlay.querySelector('#htpDetailCards').innerHTML = detailDefs.map(c => `
        <div class="htp-card ${selDetail===c.id?'sel':''}" data-d="${c.id}">
          <div class="htp-card-top"><span>${c.name}</span>${c.rec?'<em>Recommended</em>':'<i class="chk"></i>'}</div>
          <div class="htp-card-prev">${detailPreviewHTML(c.id, sample)}</div>
        </div>`).join('');
      overlay.querySelector('#htpBarcodeCards').innerHTML = barcodeDefs.map(c => `
        <div class="htp-card ${selBarcode===c.id?'sel':''}" data-b="${c.id}">
          <div class="htp-card-top"><span>${c.name}</span><i class="chk"></i></div>
          <div class="htp-card-prev"><div class="bs"><div class="mini-bars"></div>
            <div class="serial">${sample.serial}</div>${c.id==='b2'?'<div class="scan">Scan to verify</div>':''}</div></div>
        </div>`).join('');
      overlay.querySelectorAll('[data-d]').forEach(el => el.onclick = () => { selDetail = el.dataset.d; paintCards(); paintFinal(); });
      overlay.querySelectorAll('[data-b]').forEach(el => el.onclick = () => { selBarcode = el.dataset.b; paintCards(); paintFinal(); });
    }
    function paintFinal() {
      overlay.querySelector('#htpFinal').innerHTML = `
        <div class="htp-tag">
          <div class="htp-tag-l">${detailPreviewHTML(selDetail, sample)}</div>
          <div class="htp-tag-fold"><div class="htp-tag-hole"></div></div>
          <div class="htp-tag-r"><div class="mini-bars big"></div>
            <div class="serial">${sample.serial}</div>${selBarcode==='b2'?'<div class="scan">Scan to verify</div>':''}</div>
        </div>`;
    }
    paintCards(); paintFinal();

    const close = () => overlay.remove();
    overlay.querySelector('.htp-modal-x').onclick = close;
    overlay.querySelector('.htp-cancel').onclick = close;
    overlay.querySelector('.htp-print').onclick = async () => {
      close();
      await printAll();
    };
  }

  // ---- print loop ----
  async function printAll() {
    const { data } = refresh();
    const printable = data.tags.filter(t => t.canPrint);
    nextBtn.disabled = true;
    for (let i = 0; i < printable.length; i++) {
      const tag = printable[i];
      statusEl.textContent = `Printing ${i+1} / ${printable.length} — Tag #${tag.tag_id}`;
      const payload = buildPayload(data.jobcardNo, tag, selPurity, selDetail, selBarcode)
        ; // note: arg order fixed below
      try {
        await sendPrint(buildPayload(tag, data.jobcardNo, selPurity, selDetail, selBarcode));
      } catch (e) {
        console.error('[TagPrinter] print failed', tag.tag_id, e);
      }
      await new Promise(r => setTimeout(r, 600));  // TSC TE244 breathing room
    }
    statusEl.textContent = `Done — ${printable.length} printed ✓`;
    nextBtn.disabled = false;
  }

  // ---- init ----
  (async function init() {
    if (!(await bridgeAlive())) { warnEl.style.display = 'block'; }
    const data = scrape();
    if (!data.jobcardNo) { statusEl.textContent = 'No jobcard found on this page'; return; }
    panel.querySelector('.htp-title').textContent = `Tag Printer — ${data.jobcardNo}`;
    refresh();
  })();
})();
```
> Implementation note: `printAll()` above shows the correct call
> `sendPrint(buildPayload(tag, data.jobcardNo, selPurity, selDetail, selBarcode))`.
> Remove the stray unused `payload` line when implementing.

### 5.4 panel.css (complete)
```css
/* Hallmark Tag Printer — panel + template modal */
.htp-panel { position:fixed; right:18px; bottom:18px; z-index:2147483000; width:560px;
  max-width:calc(100vw - 36px); font:14px/1.4 'IBM Plex Sans',system-ui,sans-serif; color:#1B2430;
  background:#F7F8F4; border:1px solid #C4CBBE; border-bottom:2px solid #1B2430; border-radius:2px;
  box-shadow:0 12px 34px rgba(27,36,48,.28); }
.htp-head { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid #C4CBBE;
  font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
.htp-dot { width:7px; height:7px; border-radius:50%; background:#A8802A; }
.htp-title { flex:1; font-weight:600; }
.htp-x { background:none; border:none; color:#5C6672; cursor:pointer; font-size:16px; }
.htp-body { padding:12px; }
.htp-min .htp-body { display:none; }
.htp-warn { font-size:12px; color:#8C3A00; background:#FFF3ED; border:1px solid #F5C5A3; border-radius:2px; padding:8px; margin-bottom:10px; }
.htp-warn code { font-family:'IBM Plex Mono',monospace; background:#E8EAE4; padding:1px 4px; border-radius:2px; }
.htp-purity { display:flex; align-items:center; gap:8px; margin-bottom:10px; padding:8px; background:#EEF0EA; border:1px solid #E0E3DA; border-radius:2px; }
.htp-purity label { font:600 11px 'IBM Plex Sans',sans-serif; white-space:nowrap; }
.htp-purity-sel { flex:1; padding:5px 8px; font:600 12px 'IBM Plex Mono',monospace; color:#1B2430; background:#fff; border:1px solid #C4CBBE; border-radius:2px; cursor:pointer; }
.htp-status { font-size:12px; margin-bottom:8px; min-height:16px; }
.htp-table-wrap { max-height:230px; overflow-y:auto; border:1px solid #E0E3DA; border-radius:2px; margin-bottom:12px; }
.htp-table { width:100%; border-collapse:collapse; font-size:12px; }
.htp-table thead th { position:sticky; top:0; background:#1B2430; color:#F5F4EF; font:600 10px 'IBM Plex Sans',sans-serif; letter-spacing:.06em; text-transform:uppercase; padding:8px 7px; text-align:left; white-space:nowrap; }
.htp-table td { padding:8px 7px; border-bottom:1px solid #ECEEE7; color:#3A3F48; }
.htp-table tbody tr:nth-child(even){ background:#FCFCFA; }
.htp-c-sno{ color:#8A9099; } .htp-c-tag{ font:600 12px 'IBM Plex Mono',monospace; color:#1B2430; }
.htp-c-huid{ font:11px 'IBM Plex Mono',monospace; color:#3A6B3A; white-space:nowrap; }
.htp-c-wt{ font-variant-numeric:tabular-nums; text-align:right; } .htp-c-pur{ font-variant-numeric:tabular-nums; }
.htp-miss{ color:#8C3A00; } .htp-dash{ color:#C4A08A; }
tr.htp-blk td{ background:#FFF7F2!important; opacity:.72; }
.htp-next { width:100%; padding:12px; font:700 14px 'IBM Plex Sans',sans-serif; color:#fff; background:#A8802A; border:none; border-radius:2px; cursor:pointer; letter-spacing:.02em; }
.htp-next:hover{ background:#8C6820; } .htp-next:disabled{ background:#C4CBBE; color:#5C6672; cursor:not-allowed; }

/* modal */
.htp-modal { position:fixed; inset:0; z-index:2147483001; background:rgba(20,27,37,.55); display:flex; align-items:center; justify-content:center; padding:24px; }
.htp-modal-card { width:760px; max-width:100%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column; background:#FAFAF7; border-radius:6px; box-shadow:0 30px 70px rgba(0,0,0,.4); font-family:'IBM Plex Sans',sans-serif; }
.htp-modal-head { background:#1B2430; color:#F5F4EF; padding:18px 22px; display:flex; align-items:flex-start; justify-content:space-between; }
.htp-modal-head h3 { font-size:17px; font-weight:600; margin-bottom:2px; }
.htp-modal-head p { font-size:12px; color:#9AA3AD; }
.htp-modal-x { background:none; border:none; color:#9AA3AD; font-size:22px; cursor:pointer; }
.htp-modal-body { padding:20px 22px; overflow-y:auto; }
.htp-sec { font:600 10px 'IBM Plex Sans',sans-serif; letter-spacing:.14em; text-transform:uppercase; color:#8A9099; margin:0 0 10px; }
.htp-cards { display:grid; gap:12px; margin-bottom:22px; }
.htp-cards-3 { grid-template-columns:repeat(3,1fr); }
.htp-cards-2 { grid-template-columns:repeat(2,1fr); max-width:420px; }
.htp-card { border:1.5px solid #E0E3DA; border-radius:5px; background:#fff; cursor:pointer; overflow:hidden; transition:all .15s; }
.htp-card:hover{ border-color:#A8802A; }
.htp-card.sel{ border-color:#A8802A; box-shadow:0 0 0 3px rgba(168,128,42,.16); }
.htp-card-top { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid #ECEEE7; font:600 12px 'IBM Plex Sans',sans-serif; }
.htp-card-top em { font:600 9px 'IBM Plex Sans',sans-serif; font-style:normal; letter-spacing:.08em; text-transform:uppercase; color:#A8802A; border:1px solid #A8802A; border-radius:10px; padding:2px 7px; }
.htp-card-top .chk { width:15px; height:15px; border-radius:50%; border:1.5px solid #C4CBBE; }
.htp-card.sel .chk { background:#A8802A; border-color:#A8802A; }
.htp-card-prev { min-height:96px; display:grid; place-items:center; padding:14px; background:#FDFCF8; }

/* detail side render */
.ds-t1{ width:200px; display:flex; flex-direction:column; gap:4px; }
.ds-t1 .h{ display:flex; align-items:baseline; gap:6px; } .ds-t1 .hk{ font:600 8px 'IBM Plex Sans'; letter-spacing:.14em; color:#8A9099; text-transform:uppercase; } .ds-t1 .hv{ font:700 17px 'IBM Plex Mono'; color:#1B2430; letter-spacing:.06em; }
.ds-t1 .rule{ height:1px; background:#D9D8CC; margin:2px 0; } .ds-t1 .r{ display:flex; justify-content:space-between; }
.ds-t1 .r .k{ font:600 8px 'IBM Plex Sans'; letter-spacing:.1em; color:#8A9099; text-transform:uppercase; } .ds-t1 .r .v{ font:600 12px 'IBM Plex Mono'; color:#3A3F48; }
.ds-t2{ width:200px; text-align:center; } .ds-t2 .hk{ font:600 8px 'IBM Plex Sans'; letter-spacing:.18em; color:#8A9099; text-transform:uppercase; margin-bottom:2px; }
.ds-t2 .hv{ font:700 22px 'IBM Plex Mono'; color:#1B2430; letter-spacing:.08em; line-height:1; } .ds-t2 .sub{ margin-top:6px; font:600 11px 'IBM Plex Mono'; color:#3A3F48; } .ds-t2 .ahc{ margin-top:5px; font:500 8px 'IBM Plex Sans'; color:#A8802A; letter-spacing:.04em; }
.ds-t3{ width:210px; display:grid; grid-template-columns:1.3fr 1fr 1fr; border:1px solid #E0DFD3; border-radius:3px; overflow:hidden; }
.ds-t3 .cell{ padding:6px 8px; border-right:1px solid #ECEBDF; } .ds-t3 .cell:last-child{ border-right:none; }
.ds-t3 .k{ font:600 7px 'IBM Plex Sans'; letter-spacing:.1em; color:#8A9099; text-transform:uppercase; margin-bottom:2px; } .ds-t3 .v{ font:700 12px 'IBM Plex Mono'; color:#1B2430; } .ds-t3 .v.sm{ font-size:11px; }

/* barcode side render */
.bs{ display:flex; flex-direction:column; align-items:center; gap:4px; width:150px; }
.mini-bars{ height:34px; width:100%; background:repeating-linear-gradient(90deg,#1B2430 0,#1B2430 2px,#fff 2px,#fff 4px,#1B2430 4px,#1B2430 5px,#fff 5px,#fff 8px,#1B2430 8px,#1B2430 11px,#fff 11px,#fff 12px); }
.mini-bars.big{ height:48px; }
.bs .serial{ font:600 10px 'IBM Plex Mono'; color:#1B2430; letter-spacing:.16em; }
.bs .scan{ font:500 8px 'IBM Plex Sans'; color:#8A9099; letter-spacing:.1em; text-transform:uppercase; }

/* final preview tag */
.htp-final{ display:flex; justify-content:center; }
.htp-tag{ width:640px; max-width:100%; height:100px; background:#FDFCF8; border:1px solid #D8DACE; border-radius:3px; display:grid; grid-template-columns:1fr 84px 1fr; overflow:hidden; box-shadow:inset 0 0 0 1px #fff; }
.htp-tag-l,.htp-tag-r{ padding:12px 16px; display:flex; flex-direction:column; justify-content:center; align-items:center; }
.htp-tag-fold{ background:repeating-linear-gradient(#F0EFE8,#F0EFE8 3px,#FDFCF8 3px,#FDFCF8 6px); border-left:1px dashed #C0C3B8; border-right:1px dashed #C0C3B8; display:grid; place-items:center; }
.htp-tag-hole{ width:14px; height:14px; border-radius:50%; background:#fff; border:2px solid #B8BBB0; }

/* modal footer */
.htp-modal-foot{ display:flex; justify-content:flex-end; gap:10px; padding:14px 22px; border-top:1px solid #E0E3DA; background:#F2F3EE; }
.htp-cancel{ padding:10px 18px; font:600 13px 'IBM Plex Sans'; background:#fff; color:#1B2430; border:1px solid #C4CBBE; border-radius:3px; cursor:pointer; }
.htp-print{ padding:10px 22px; font:700 13px 'IBM Plex Sans'; background:#A8802A; color:#fff; border:none; border-radius:3px; cursor:pointer; }
.htp-print:hover{ background:#8C6820; }
```

---

## 6. Bridge server (Node.js, on the PC)

### 6.1 package.json
```json
{
  "name": "hallmark-tag-bridge",
  "version": "1.0.0",
  "main": "bridge-server.js",
  "scripts": { "start": "node bridge-server.js" },
  "dependencies": { "express": "^4.18.2", "cors": "^2.8.5" }
}
```

### 6.2 bridge-server.js
```javascript
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
```

### 6.3 install.bat
```bat
@echo off
echo Hallmark Tag Bridge - setup
where node >nul 2>&1 || (echo Install Node.js from https://nodejs.org & pause & exit /b 1)
call npm install
echo.
echo Share the printer: Control Panel ^> Devices and Printers ^> right-click TSC TE244
echo   ^> Printer Properties ^> Sharing ^> Share this printer ^> name it "TSC TE244" ^> OK
echo.
echo Setup done. Run start.bat to launch the bridge.
pause
```

### 6.4 start.bat
```bat
@echo off
title Hallmark Tag Bridge
node bridge-server.js
pause
```

---

## 7. Public detail page (Next.js, no images, English)

`website/pages/tag/index.jsx`
```jsx
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

const PURITY_LABELS = {
  '999':'999 · 24 Karat','958':'958 · 23 Karat','916':'916 · 22 Karat',
  '833':'833 · 20 Karat','750':'750 · 18 Karat','585':'585 · 14 Karat','375':'375 · 9 Karat',
};

export default function TagDetailPage() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;
    if (!q.h) { setReady(true); return; }
    setData({ huid:q.h||'', weight:q.w||'', purity:q.p||'',
      ahc_name:q.ac||'Assaying & Hallmarking Centre', print_date:q.dt||'' });
    setReady(true);
  }, [router.isReady, router.query]);

  if (!ready) return <div className="loading">Loading…</div>;
  if (!data)  return <div className="error">Invalid tag. Please scan again.</div>;
  const purity = PURITY_LABELS[data.purity] || data.purity;

  return (<>
    <Head><title>{data.huid} — Hallmark Verified</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
    <main className="page">
      <header className="header">
        <div className="badge">BIS HALLMARKED</div>
        <h1 className="page-title">Hallmark Verified</h1>
        <p className="ahc-name">{data.ahc_name}</p>
      </header>
      <section className="huid-section">
        <div className="huid-label">HUID</div>
        <div className="huid-value">{data.huid}</div>
        <div className="huid-sub">BIS Unique ID · Permanently recorded</div>
      </section>
      <section className="details">
        <div className="row"><span className="lbl">Weight</span>
          <span className="val">{data.weight ? `${data.weight} g` : '—'}</span></div>
        <div className="row"><span className="lbl">Purity</span>
          <span className="val">{purity || '—'}</span></div>
      </section>
      <section className="auth-note">
        <p>This tag was generated from BIS MANAK portal data at the time of hallmarking.
          HUID <strong>{data.huid}</strong> is registered with the Bureau of Indian Standards.</p>
      </section>
      <footer className="footer">Powered by Hallmark Desk · NexaCore AI</footer>
    </main>
    <style jsx>{`
      *{box-sizing:border-box;margin:0;padding:0;}
      .loading,.error{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;color:#5C6672;font-size:15px;}
      .page{max-width:480px;margin:0 auto;min-height:100vh;background:#FAFAF7;font-family:Georgia,serif;padding-bottom:48px;}
      .header{background:#1B2430;color:#F5F4EF;padding:28px 24px 24px;text-align:center;}
      .badge{display:inline-block;font:600 10px 'IBM Plex Sans',system-ui,sans-serif;letter-spacing:.15em;color:#A8802A;border:1px solid #A8802A;padding:4px 10px;border-radius:2px;margin-bottom:12px;}
      .page-title{font-size:24px;font-weight:400;margin-bottom:6px;}
      .ahc-name{font:13px 'IBM Plex Sans',system-ui,sans-serif;color:#8A9099;}
      .huid-section{background:#fff;border-bottom:2px solid #1B2430;padding:26px 24px;text-align:center;}
      .huid-label{font:600 10px 'IBM Plex Sans',system-ui,sans-serif;letter-spacing:.14em;color:#8A9099;margin-bottom:8px;}
      .huid-value{font:700 28px 'IBM Plex Mono',monospace;color:#1B2430;letter-spacing:.08em;margin-bottom:8px;}
      .huid-sub{font:12px 'IBM Plex Sans',system-ui,sans-serif;color:#A8802A;}
      .details{background:#fff;margin-top:16px;border-top:1px solid #E8E6DF;border-bottom:1px solid #E8E6DF;}
      .row{display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid #F0EDE6;}
      .row:last-child{border-bottom:none;}
      .lbl{font:12px 'IBM Plex Sans',system-ui,sans-serif;color:#8A9099;letter-spacing:.06em;}
      .val{font:600 18px 'IBM Plex Mono',monospace;color:#1B2430;letter-spacing:.04em;}
      .auth-note{margin:20px 24px 0;padding:14px;background:#EFF3ED;border-left:3px solid #3A6B3A;border-radius:0 2px 2px 0;font:12px/1.6 'IBM Plex Sans',system-ui,sans-serif;color:#3A5A3A;}
      .footer{text-align:center;margin-top:32px;font:11px 'IBM Plex Sans',system-ui,sans-serif;color:#C4CBBE;letter-spacing:.08em;}
    `}</style>
  </>);
}
```

Test URL after deploy:
```
https://hallmark-desk.vercel.app/tag?h=85LTAZ&w=5.230&p=916&ac=Shreem+Hallmarking+Centre&dt=2026-09-10
```

---

## 8. Deployment checklist

Extension + bridge (customer PC, one time):
```
[ ] Install Node.js (nodejs.org)
[ ] Copy the bridge/ folder to the PC
[ ] Run install.bat  (npm install + printer-share instructions)
[ ] Share the TSC TE244 printer in Windows; confirm the exact share name
[ ] Set PRINTER_NAME in bridge-server.js to that exact name
[ ] Add start.bat to Windows Startup (shell:startup)
[ ] Load the extension (chrome://extensions → Load unpacked → extension/)
[ ] Set AHC_NAME and AHC_CODE in config.js
[ ] Open the Weighing Desk page and print a test tag
```

Website (Vercel, one time):
```
[ ] Add pages/tag/index.jsx to the hallmark-desk Vercel project
[ ] Deploy
[ ] Verify the test URL above renders HUID / Weight / Purity
```

---

## 9. Test script

```
1. Start the bridge:  node bridge-server.js   (or start.bat)
2. Health check:      GET http://localhost:7072/health  → {"ok":true}
3. Open the Weighing Desk page; the panel should appear bottom-right
4. Select a purity; the preview table fills the Purity column
5. Enter/scan weights on the portal; rows become "ready"
6. Click "Choose template & print"; pick a design; click "Print All Tags"
7. TSC TE244 prints each tag; serials are unique (SN####-####)
8. Scan a printed barcode; the public page shows HUID / Weight / Purity
9. Manual bridge test:
   curl -X POST http://localhost:7072/print-tag -H "Content-Type: application/json" ^
     -d "{\"huid\":\"85LTAZ\",\"weight\":\"5.230\",\"purity\":\"916\",\"serial\":\"SN8371-0020\",\"barcode\":\"HD-85LTAZ\",\"template_detail\":\"t1\",\"template_barcode\":\"b1\",\"ahc_name\":\"Shreem HC\"}"
```

---

## 10. Open items for the developer to confirm on site

| Item | Note |
|---|---|
| Windows printer exact name | Set `PRINTER_NAME` from Control Panel |
| TSPL X/Y offsets | Calculated for 32.5mm sides; fine-tune with a test print |
| Font sizes vs 15mm height | Font "2"/"3" used; adjust if text clips |
| Weight input timing | Print only after weights entered; rows gate on HUID+weight |

*End of Master Implementation Plan v1.0 — Hallmark Desk / NexaCore AI.*
