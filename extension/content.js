/* ================================================================
   HALLMARK TAG PRINTER — content script
   Runs on huid.manakonline.in (Weighing Desk page)
   Flow: scrape -> purity dropdown -> preview table -> template -> print
   ================================================================ */
(function () {
  // ---- page detection (DOM-based, reliable) ----
  function isWeighingDesk() {
    return (!!document.getElementById('tabWeight')
         || !!document.getElementById('weightTable'))
        && !!document.getElementById('str_job_no');
  }
  if (!isWeighingDesk()) return;

  // The Weighing Desk has TWO tables:
  //   #tabWeight   — "Articles Weight Capture": rows still to be weighed,
  //                  weight is a live input, has a Save button.
  //   #weightTable — "Article Weight Details": already-weighed articles,
  //                  HUID + weight are plain text (this is what we print).
  // Both are DataTables with pagination, so only the current page's rows are
  // in the DOM. We read #weightTable first (completed items) and fall back to
  // #tabWeight; expandTable() forces all rows to render so nothing is missed.
  const PRINT_TABLE = 'weightTable';
  const ENTRY_TABLE = 'tabWeight';

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

  // Force a DataTables-driven table to show every row (default page size is
  // 10). We bump its "length" <select> to the largest option and fire a
  // native change event, which the page's jQuery handler picks up and redraws.
  function expandTable(tblId) {
    const sel = document.querySelector(`select[name="${tblId}_length"]`);
    if (!sel || !sel.options.length) return;
    const nums = Array.from(sel.options).map(o => parseInt(o.value, 10)).filter(n => !isNaN(n));
    if (!nums.length) return;
    const max = String(Math.max(...nums));
    if (sel.value !== max) {
      sel.value = max;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Read one table's rows into tag objects. Column order is the same for both
  // tables: [S No, AHC Tag, Material, Item Category, HUID, Weight, (Save)].
  // Weight is a live input in #tabWeight and plain text in #weightTable.
  function readTable(tblId) {
    const tbl = document.getElementById(tblId);
    if (!tbl) return [];
    let rows = tbl.querySelectorAll('tbody tr');
    if (!rows.length) rows = tbl.querySelectorAll('tr');
    const out = [];
    rows.forEach((tr) => {
      if (tr.querySelector('td.dataTables_empty')) return;   // "No data available"
      const td = tr.querySelectorAll('td');
      if (td.length < 5) return;                             // header / spacer rows
      const tagEl  = tr.querySelector('.tagIdCls');
      const tagId  = ((tagEl ? tagEl.textContent : td[1].textContent) || '').trim();
      if (!tagId) return;
      const sno      = (td[0].textContent || '').trim();
      const material = (td[2] ? td[2].textContent : '').trim();
      const article  = (td[3] ? td[3].textContent : '').trim();
      const huid     = (td[4] ? td[4].textContent : '').trim();
      const wInput   = tr.querySelector('input.weightCls, input.scan-input, input[name="articlWeight"]');
      const weight   = (wInput ? (wInput.value || '') : (td[5] ? td[5].textContent : '')).trim();
      out.push({
        position: sno ? parseInt(sno, 10) : out.length + 1,
        tag_id: tagId, material, article, huid, weight,
        canPrint: !!huid && !!weight
      });
    });
    return out;
  }

  // ---- scraper ----
  function scrape() {
    const jobNo = (document.getElementById('str_job_no')?.value || '').trim();
    const reqNo = (document.getElementById('str_request_no')?.value || '').trim();
    // Prefer the completed-articles table; fall back to the entry table while
    // weighing is still in progress.
    let tags = readTable(PRINT_TABLE);
    if (!tags.length) tags = readTable(ENTRY_TABLE);
    return { jobcardNo: jobNo, requestNo: reqNo, tags };
  }

  // ---- serial (unique per tag) ----
  function serialFor(jobcardNo, tagId) {
    const base = String(jobcardNo).slice(-4);
    const seq  = String(tagId).padStart(4, '0');
    return `SN${base}-${seq}`;
  }

  // ---- tamper signature (HMAC-SHA256, first 16 hex chars) ----
  // Signs the tag's values so the verification page can reject edited URLs.
  // The canonical string and secret MUST match the website's verifier.
  async function signParams(p) {
    const msg = [p.h, p.w, p.p].join('|');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(TAG_CONFIG.SIGN_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const buf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
  }

  // ---- payload for one tag ----
  async function buildPayload(tag, jobcardNo, purityCode, templateDetail) {
    const serial = serialFor(jobcardNo, tag.tag_id);
    // Keep the URL short (only h/w/p/s) so the printed QR stays coarse enough
    // to scan on the narrow tag. The centre name lives on the website.
    const params = { h: tag.huid, w: tag.weight, p: purityCode };
    const s = await signParams(params);
    const qs = new URLSearchParams({ ...params, s }).toString();
    return {
      huid: tag.huid, weight: tag.weight, purity: purityCode,
      article: tag.article,
      serial, barcode: `HD-${tag.huid}`,
      ahc_name: TAG_CONFIG.AHC_NAME,
      template_detail: templateDetail,      // 'd1'..'d5'
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
  let selDetail  = 'd1';   // default design (recommended)

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

  // A QR-looking preview (illustrative only; the real scannable QR is printed
  // by the bridge). Deterministic pattern with three finder squares.
  function qrPreviewSVG(px) {
    const n = 21, cell = px / n;
    let seed = 20260916, rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let cells = '';
    const finder = (ox, oy) => {
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        if (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))
          cells += `<rect x="${(ox + j) * cell}" y="${(oy + i) * cell}" width="${cell}" height="${cell}"/>`;
      }
    };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const inFinder = (r < 8 && c < 8) || (r < 8 && c >= n - 8) || (r >= n - 8 && c < 8);
      if (!inFinder && rnd() > 0.5)
        cells += `<rect x="${c * cell}" y="${r * cell}" width="${cell}" height="${cell}"/>`;
    }
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" xmlns="http://www.w3.org/2000/svg" style="display:block"><rect width="${px}" height="${px}" fill="#fff"/><g fill="#1B2430">${cells}</g></svg>`;
  }

  // ---- template modal ----
  // Weight always shown to 3 decimals in previews (matches the printed tag).
  function wt3(v) { const n = parseFloat(v); return isFinite(n) ? n.toFixed(3) : (v || '0.000'); }

  // Self-contained (inline-styled) previews of the 5 printed designs d1..d5.
  // Each shows Article, HUID, Weight (3-dec), Purity and Centre name so the
  // operator can judge the tag before printing. Layouts mirror the bridge's
  // buildTSPL output for each design id.
  function detailPreviewHTML(tpl, d) {
    const art = (d.article || '—').toUpperCase();
    const ctr = TAG_CONFIG.AHC_NAME.toUpperCase();
    const w = wt3(d.wt);
    const wrap = 'font-family:Arial,Helvetica,sans-serif;color:#111;box-sizing:border-box;width:100%;height:100%;background:#fff;';
    if (tpl === 'd1') return `<div style="${wrap}border:1.5px solid #111;padding:5px 7px;">
      <div style="font-size:8px;letter-spacing:.5px;color:#555;">HUID</div>
      <div style="font-size:15px;font-weight:700;letter-spacing:.5px;line-height:1.1;">${d.huid}</div>
      <div style="font-size:9px;font-weight:600;margin-top:4px;">${art}</div>
      <div style="display:flex;justify-content:space-between;font-size:9px;font-weight:600;margin-top:2px;">
        <span>Wt ${w}g</span><span>${d.purCode}</span></div>
      <div style="font-size:7px;color:#555;margin-top:3px;letter-spacing:.3px;">${ctr}</div></div>`;
    if (tpl === 'd2') return `<div style="${wrap}border:1px solid #111;overflow:hidden;">
      <div style="background:#111;color:#fff;font-size:7.5px;font-weight:700;letter-spacing:.4px;padding:3px 6px;">${ctr}</div>
      <div style="padding:4px 7px;">
        <div style="font-size:8px;color:#555;">HUID</div>
        <div style="font-size:15px;font-weight:700;line-height:1.1;">${d.huid}</div>
        <div style="font-size:9px;font-weight:600;margin-top:4px;">${art} &nbsp; ${w}g &nbsp; ${d.purCode}</div></div></div>`;
    if (tpl === 'd3') return `<div style="${wrap}border-left:3px solid #111;padding:5px 8px;">
      <div style="font-size:7.5px;color:#555;letter-spacing:.4px;">${ctr}</div>
      <div style="font-size:20px;font-weight:800;letter-spacing:.5px;line-height:1.05;margin-top:1px;">${d.huid}</div>
      <div style="font-size:9px;font-weight:600;margin-top:5px;">${art}</div>
      <div style="font-size:9px;font-weight:600;margin-top:1px;">Wt ${w}g &nbsp; ${d.purCode}</div></div>`;
    if (tpl === 'd4') return `<div style="${wrap}border:1.5px solid #111;padding:4px 7px;">
      <div style="font-size:7.5px;font-weight:700;color:#555;letter-spacing:.4px;">${ctr}</div>
      <div style="border-top:1px solid #111;margin:3px 0;"></div>
      <table style="width:100%;border-collapse:collapse;font-size:9px;">
        <tr><td style="color:#555;width:34px;">HUID</td><td style="font-weight:700;">${d.huid}</td></tr>
        <tr><td style="color:#555;">ART</td><td style="font-weight:600;">${art}</td></tr>
        <tr><td style="color:#555;">WT</td><td style="font-weight:600;">${w}g</td></tr>
        <tr><td style="color:#555;">PUR</td><td style="font-weight:600;">${d.purCode}</td></tr></table></div>`;
    // d5 minimal clean
    return `<div style="${wrap}padding:6px 8px;">
      <div style="font-size:7.5px;color:#555;letter-spacing:.4px;">${ctr}</div>
      <div style="font-size:19px;font-weight:800;letter-spacing:.5px;line-height:1.05;margin-top:1px;">${d.huid}</div>
      <div style="border-top:1px solid #111;margin:5px 0 4px;"></div>
      <div style="font-size:9px;font-weight:600;">${art}</div>
      <div style="font-size:9px;font-weight:600;margin-top:1px;">${w}g &nbsp; ${d.purCode}</div></div>`;
  }

  function openTemplateModal() {
    const { data } = refresh();
    const sample = (() => {
      const t = data.tags.find(x => x.canPrint) || data.tags[0];
      return { huid: t.huid || '------', wt: t.weight || '0.000',
        article: t.article || '', pur: PURITY_LABEL[selPurity], purCode: selPurity,
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
          <p class="htp-sec">Choose a design (all show Article · HUID · Weight · Purity · QR · Centre)</p>
          <div class="htp-cards htp-cards-3" id="htpDetailCards"></div>
          <p class="htp-sec">Live preview</p>
          <div class="htp-final" id="htpFinal"></div>
        </div>
        <div class="htp-modal-foot">
          <button class="htp-cancel">Cancel</button>
          <button class="htp-print">Print All Tags</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const detailDefs = [
      {id:'d1',name:'Bordered grid',rec:true},
      {id:'d2',name:'Header bar'},
      {id:'d3',name:'Big HUID'},
      {id:'d4',name:'Labeled box'},
      {id:'d5',name:'Minimal'},
    ];

    function paintCards() {
      overlay.querySelector('#htpDetailCards').innerHTML = detailDefs.map(c => `
        <div class="htp-card ${selDetail===c.id?'sel':''}" data-d="${c.id}">
          <div class="htp-card-top"><span>${c.name}</span>${c.rec?'<em>Recommended</em>':'<i class="chk"></i>'}</div>
          <div class="htp-card-prev">${detailPreviewHTML(c.id, sample)}</div>
        </div>`).join('');
      overlay.querySelectorAll('[data-d]').forEach(el => el.onclick = () => { selDetail = el.dataset.d; paintCards(); paintFinal(); });
    }
    function paintFinal() {
      overlay.querySelector('#htpFinal').innerHTML = `
        <div class="htp-tag">
          <div class="htp-tag-l">${detailPreviewHTML(selDetail, sample)}</div>
          <div class="htp-tag-fold"><div class="htp-tag-hole"></div></div>
          <div class="htp-tag-r">${qrPreviewSVG(60)}
            <div class="serial">${sample.serial}</div><div class="scan">Scan to verify</div></div>
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
    if (!printable.length) { statusEl.textContent = 'Nothing to print.'; return; }

    // Don't pretend to print when the local bridge isn't reachable.
    if (!(await bridgeAlive())) {
      warnEl.style.display = 'block';
      statusEl.innerHTML = '<span class="htp-miss">✕ Bridge server not running — start start.bat on the PC, then reload.</span>';
      return;
    }

    nextBtn.disabled = true;
    let ok = 0, fail = 0, lastErr = '';
    for (let i = 0; i < printable.length; i++) {
      const tag = printable[i];
      statusEl.textContent = `Printing ${i+1} / ${printable.length} — Tag #${tag.tag_id}`;
      try {
        await sendPrint(await buildPayload(tag, data.jobcardNo, selPurity, selDetail));
        ok++;
      } catch (e) {
        fail++; lastErr = (e && e.message) ? e.message : String(e);
        console.error('[TagPrinter] print failed', tag.tag_id, e);
      }
      await new Promise(r => setTimeout(r, 600));  // TSC TE244 breathing room
    }
    statusEl.innerHTML = fail
      ? `<span class="htp-miss">Printed ${ok}, failed ${fail}. ${lastErr ? '('+lastErr+')' : ''}</span>`
      : `Done — ${ok} printed ✓`;
    nextBtn.disabled = false;
  }

  // ---- keep the panel in sync with a table that loads/changes after us ----
  // The articles table often fills in via AJAX after document_idle, and the
  // portal reloads/redraws it after each weight save. Re-scan whenever it
  // mutates, and retry a few times on first load in case rows arrive late.
  function watchTable() {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; refresh(); }, 150);
    };
    [PRINT_TABLE, ENTRY_TABLE].forEach(id => {
      const tbl = document.getElementById(id);
      if (tbl) new MutationObserver(schedule).observe(tbl, { childList: true, subtree: true, characterData: true });
    });
  }

  // ---- init ----
  (async function init() {
    if (!(await bridgeAlive())) { warnEl.style.display = 'block'; }
    const data = scrape();
    if (!data.jobcardNo) { statusEl.textContent = 'No jobcard found on this page'; return; }
    panel.querySelector('.htp-title').textContent = `Tag Printer — ${data.jobcardNo}`;
    watchTable();
    // Show every row (DataTables defaults to 10 per page) before scraping.
    expandTable(PRINT_TABLE);
    expandTable(ENTRY_TABLE);
    refresh();
    // Fallback retries: DataTables redraws async, and the table may load late.
    [400, 900, 1800, 3500].forEach(ms => setTimeout(() => { expandTable(PRINT_TABLE); refresh(); }, ms));
  })();
})();
