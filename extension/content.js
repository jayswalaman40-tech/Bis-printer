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
  // Gold codes are the plain fineness (916 …). Silver codes carry an "S"
  // prefix (S925 …) so a silver 999 is never read as 24K gold — the code goes
  // into the signed QR URL, and the bridge and website decode it the same way.
  const PURITY_OPTIONS = [
    { code: '999', label: '24K · 999', metal: 'Gold' },
    { code: '958', label: '23K · 958', metal: 'Gold' },
    { code: '916', label: '22K · 916', metal: 'Gold' },
    { code: '833', label: '20K · 833', metal: 'Gold' },
    { code: '750', label: '18K · 750', metal: 'Gold' },
    { code: '585', label: '14K · 585', metal: 'Gold' },
    { code: '375', label: '9K · 375',  metal: 'Gold' },
    { code: 'S999', label: 'Silver · 999', metal: 'Silver' },
    { code: 'S990', label: 'Silver · 990', metal: 'Silver' },
    { code: 'S970', label: 'Silver · 970', metal: 'Silver' },
    { code: 'S925', label: 'Silver · 925 (Sterling)', metal: 'Silver' },
    { code: 'S900', label: 'Silver · 900', metal: 'Silver' },
    { code: 'S835', label: 'Silver · 835', metal: 'Silver' },
    { code: 'S800', label: 'Silver · 800', metal: 'Silver' },
  ];
  // One extension per metal: config.js METAL = 'Gold' or 'Silver' limits the
  // purity list (anything else shows both). The full list above stays the
  // reference for labels and the material check.
  const METAL = ['Gold', 'Silver'].includes(TAG_CONFIG.METAL) ? TAG_CONFIG.METAL : '';
  const METAL_OPTIONS = PURITY_OPTIONS.filter(o => !METAL || o.metal === METAL);
  const PURITY_LABEL = Object.fromEntries(PURITY_OPTIONS.map(o => [o.code, o.label]));
  // What the purity looks like on the printed tag: "916" / "925 SILVER".
  const purityShort = (code) => /^S\d+$/.test(code || '') ? `${code.slice(1)} SILVER` : (code || '');

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
    // Short path form: /t/<huid>/<weight>/<purity>/<sig> — much shorter than a
    // query string, so the QR stays coarse enough to scan on the narrow tag.
    const seg = (v) => encodeURIComponent(String(v == null ? '' : v));
    const path = [params.h, params.w, params.p, s].map(seg).join('/');
    const url = `${TAG_CONFIG.DETAIL_BASE}/${path}`;
    // We generate the QR ourselves and send the matrix to the bridge, which
    // prints it as a bitmap — the printer no longer generates the QR.
    const qr = makeQR(url);
    return {
      huid: tag.huid, weight: tag.weight, purity: purityCode,
      article: tag.article,
      serial, barcode: `HD-${tag.huid}`,
      tag_no: tag.tag_id,                   // AHC tag number, printed as "TAG - n"
      ahc_name: TAG_CONFIG.AHC_NAME,
      template_detail: templateDetail,      // 'd1'..'d5'
      detail_url: url,
      qr_rows: qr.rows, qr_count: qr.count
    };
  }

  // ---- bridge calls ----
  // Sent through the extension's background worker, not fetched from the BIS
  // page: Chrome blocks (or asks permission for) a public website talking to
  // localhost, but the extension itself has host permission for the bridge.
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(r || { ok: false, error: 'no response from extension' });
        });
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }
  async function bridgeAlive() {
    const r = await bg({ type: 'bridge-health' });
    return !!(r && r.ok);
  }
  async function sendPrint(payload) {
    const r = await bg({ type: 'bridge-print', payload });
    if (!r || !r.ok) throw new Error((r && r.error) || 'print failed');
    return r;
  }

  // ---- state ----
  let selPurity  = '';
  let selDetail  = 'd1';   // default design (recommended)

  // ---- build panel ----
  const panel = document.createElement('div');
  panel.className = 'htp-panel' + (METAL ? ' htp-' + METAL.toLowerCase() : '');
  // If the other metal's extension already added its panel, sit to its left.
  const others = document.querySelectorAll('.htp-panel').length;
  if (others) panel.style.right = (18 + others * 574) + 'px';
  panel.innerHTML = `
    <div class="htp-head">
      <span class="htp-dot"></span>
      <span class="htp-title">Tag Printer${METAL ? ' · ' + METAL : ''}</span>
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
          ${(METAL ? [METAL] : ['Gold', 'Silver']).map(m => `<optgroup label="${m}">${METAL_OPTIONS.filter(o => o.metal === m)
            .map(o => `<option value="${o.code}">${o.label}</option>`).join('')}</optgroup>`).join('')}
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
    // Guard: the portal's Material column says Gold/Silver — refuse a purity
    // of the other metal so a silver jobcard can't get gold tags (or vice versa).
    const selMetal = (PURITY_OPTIONS.find(o => o.code === selPurity) || {}).metal;
    const mats = data.tags.map(t => (t.material || '').toLowerCase());
    const wrongMetal = selMetal && mats.some(m => m.includes(selMetal === 'Gold' ? 'silver' : 'gold'));
    if (wrongMetal) {
      const other = selMetal === 'Gold' ? 'Silver' : 'Gold';
      statusEl.innerHTML = `<span class="htp-miss">This jobcard's material is ${other}, but a ${selMetal} purity is selected. Choose a ${other} purity.</span>`;
    }
    nextBtn.disabled = !(selPurity && printable > 0) || !!wrongMetal;
    nextBtn.textContent = !selPurity ? 'Select purity first'
      : wrongMetal ? 'Purity does not match material'
      : `Choose template & print (${printable})`;
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

  // ---- REAL QR generation (we build the QR ourselves, not the printer) ----
  // Uses the bundled qrcode-generator lib. Returns the module matrix as an
  // array of '1'/'0' row strings; the SAME matrix is shown in the preview and
  // sent to the bridge to print as a bitmap, so preview == printed exactly.
  function makeQR(text) {
    const qr = qrcode(0, 'M');          // type 0 = auto-fit, ECC level M
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < n; r++) {
      let s = '';
      for (let c = 0; c < n; c++) s += qr.isDark(r, c) ? '1' : '0';
      rows.push(s);
    }
    return { count: n, rows };
  }

  // Render a real QR matrix to crisp SVG (with a white quiet-zone border).
  function qrRealSVG(rows, px) {
    const n = rows.length, quiet = 2, total = n + quiet * 2, cell = px / total;
    let cells = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (rows[r][c] === '1')
        cells += `<rect x="${((c + quiet) * cell).toFixed(2)}" y="${((r + quiet) * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
    }
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" xmlns="http://www.w3.org/2000/svg" style="display:block"><rect width="${px}" height="${px}" fill="#fff"/><g fill="#000" shape-rendering="crispEdges">${cells}</g></svg>`;
  }

  // ---- template modal ----
  // Weight always shown to 3 decimals in previews (matches the printed tag).
  function wt3(v) { const n = parseFloat(v); return isFinite(n) ? n.toFixed(3) : (v || '0.000'); }

  // Self-contained (inline-styled) previews of the 5 printed designs d1..d5.
  // Each shows Article, HUID, Weight (3-dec), Purity and Centre name so the
  // operator can judge the tag before printing. Layouts mirror the bridge's
  // buildTSPL output for each design id.
  // Silver designs s1..s4 — details side only; mirrors the bridge's
  // buildTSPLSilverLarge. The tag number is shown on the other side.
  function silverPreviewHTML(tpl, d) {
    const w = wt3(d.wt), pur = (d.purCode || '').replace(/ SILVER$/, '');
    const wrap = 'font-family:Arial,Helvetica,sans-serif;color:#111;box-sizing:border-box;width:100%;height:100%;background:#fff;display:flex;flex-direction:column;justify-content:center;';
    const row = (k, v, big) => `<div style="display:flex;align-items:baseline;gap:6px;"><span style="font-size:8px;letter-spacing:.08em;color:#555;width:44px;">${k}</span><span style="font-size:${big ? 14 : 10}px;font-weight:700;">${v}</span></div>`;
    if (tpl === 's2') return `<div style="${wrap}border:1.5px solid #111;padding:0;justify-content:flex-start;">
      <div style="background:#111;color:#fff;font-size:8.5px;font-weight:700;letter-spacing:.08em;padding:3px 8px;">SILVER &nbsp;|&nbsp; PURITY ${pur}</div>
      <div style="padding:6px 8px;">${row('HUID', d.huid, true)}${row('WEIGHT', w + ' g', true)}</div></div>`;
    if (tpl === 's3') return `<div style="${wrap}padding:6px 8px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:.08em;line-height:1.05;border-bottom:2.5px solid #111;padding-bottom:3px;">${d.huid}</div>
      <div style="font-size:11px;font-weight:700;margin-top:5px;"><span style="font-size:7.5px;color:#555;">WT</span>&nbsp; ${w} g</div>
      <div style="font-size:11px;font-weight:700;margin-top:1px;"><span style="font-size:7.5px;color:#555;">PUR</span>&nbsp; ${pur} | SILVER</div></div>`;
    if (tpl === 's4') {
      const r = (k, v) => `<tr><td style="font-size:7.5px;letter-spacing:.06em;color:#333;border:1px solid #111;padding:2px 5px;width:40px;">${k}</td><td style="font-size:11px;font-weight:700;border:1px solid #111;padding:1px 6px;">${v}</td></tr>`;
      return `<div style="${wrap}padding:4px;"><table style="width:100%;border-collapse:collapse;border:2px solid #111;">${r('HUID', d.huid)}${r('WEIGHT', w + ' g')}${r('PURITY', pur)}${r('METAL', 'SILVER')}</table></div>`;
    }
    return `<div style="${wrap}padding:6px 8px;gap:2px;">
      ${row('HUID :', d.huid, true)}${row('WEIGHT :', w + ' g')}${row('PURITY :', pur)}${row('METAL :', 'SILVER')}</div>`;
  }

  function detailPreviewHTML(tpl, d) {
    const art = (d.article || '—').toUpperCase();
    const w = wt3(d.wt);
    const wrap = 'font-family:Arial,Helvetica,sans-serif;color:#111;box-sizing:border-box;width:100%;height:100%;background:#fff;display:flex;flex-direction:column;justify-content:center;';
    if (tpl === 'd2') return `<div style="${wrap}border:1px solid #111;padding:6px 8px;">
      <div style="font-size:8px;color:#555;">HUID</div>
      <div style="font-size:16px;font-weight:700;line-height:1.1;border-bottom:1px solid #111;padding-bottom:3px;">${d.huid}</div>
      <div style="font-size:9px;font-weight:600;margin-top:5px;">${art}</div>
      <div style="font-size:9px;font-weight:600;margin-top:1px;">${w}g &nbsp; ${d.purCode}</div></div>`;
    if (tpl === 'd3') return `<div style="${wrap}border-left:3px solid #111;padding:6px 8px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px;line-height:1.05;">${d.huid}</div>
      <div style="font-size:9px;font-weight:600;margin-top:6px;">${art}</div>
      <div style="font-size:9px;font-weight:600;margin-top:1px;">Wt ${w}g &nbsp; ${d.purCode}</div></div>`;
    if (tpl === 'd4') return `<div style="${wrap}border:1.5px solid #111;padding:5px 8px;">
      <table style="width:100%;border-collapse:collapse;font-size:9px;">
        <tr><td style="color:#555;width:34px;">HUID</td><td style="font-weight:700;font-size:12px;">${d.huid}</td></tr>
        <tr><td colspan="2" style="border-bottom:1px solid #111;height:4px;"></td></tr>
        <tr><td style="color:#555;">ART</td><td style="font-weight:600;">${art}</td></tr>
        <tr><td style="color:#555;">WT</td><td style="font-weight:600;">${w}g</td></tr>
        <tr><td style="color:#555;">PUR</td><td style="font-weight:600;">${d.purCode}</td></tr></table></div>`;
    if (tpl === 'd5') return `<div style="${wrap}padding:8px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px;line-height:1.05;">${d.huid}</div>
      <div style="border-top:1px solid #111;margin:6px 0 4px;"></div>
      <div style="font-size:9px;font-weight:600;">${art} &nbsp; ${w}g &nbsp; ${d.purCode}</div></div>`;
    // d1 (default): clean grid
    return `<div style="${wrap}border:1.5px solid #111;padding:5px 8px;">
      <div style="font-size:8px;letter-spacing:.5px;color:#555;">HUID</div>
      <div style="font-size:16px;font-weight:700;letter-spacing:.5px;line-height:1.1;">${d.huid}</div>
      <div style="font-size:9px;font-weight:600;margin-top:5px;">${art}</div>
      <div style="display:flex;justify-content:space-between;font-size:9px;font-weight:600;margin-top:2px;">
        <span>Wt ${w}g</span><span>${d.purCode}</span></div></div>`;
  }

  async function openTemplateModal() {
    const { data } = refresh();
    const printable = data.tags.filter(t => t.canPrint);
    const sample = (() => {
      const t = printable[0] || data.tags[0] || {};
      return { huid: t.huid || '------', wt: t.weight || '0.000',
        article: t.article || '', pur: PURITY_LABEL[selPurity], purCode: purityShort(selPurity),
        serial: serialFor(data.jobcardNo, t.tag_id), tagNo: t.tag_id || '—' };
    })();

    // Tag numbers (the portal's AHC Tag column) used by the From/To filter.
    const nums = printable.map(tagNum);
    const firstNo = nums.length ? Math.min(...nums) : 1;
    const lastNo  = nums.length ? Math.max(...nums) : 1;

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
          <p class="htp-sec">Print only a range of tags (leave blank to print all)</p>
          <div class="htp-range">
            <label>From tag <input type="number" min="1" id="htpFrom" placeholder="${firstNo}"></label>
            <label>To tag <input type="number" min="1" id="htpTo" placeholder="${lastNo}"></label>
            <span id="htpRangeInfo"></span>
          </div>
          <p class="htp-sec" id="htpListHead">Tags to print (${printable.length}) — real QR, exactly what will print</p>
          <div class="htp-qrlist" id="htpQrList"><div class="htp-qrloading">Generating QR codes…</div></div>
        </div>
        <div class="htp-modal-foot">
          <button class="htp-cancel">Cancel</button>
          <button class="htp-print">Print All Tags (${printable.length})</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Silver purities get their own designs (no QR, tag number on the back).
    const isSilver = /^S\d+$/.test(selPurity);
    if (isSilver && !/^s[1-4]$/.test(selDetail)) selDetail = 's1';
    if (!isSilver && !/^d[1-5]$/.test(selDetail)) selDetail = 'd1';
    const silverDefs = [
      {id:'s1',name:'Classic',rec:true},
      {id:'s2',name:'Framed'},
      {id:'s3',name:'Bold HUID'},
      {id:'s4',name:'Grid'},
    ];
    const previewFor = (id) => isSilver ? silverPreviewHTML(id, sample) : detailPreviewHTML(id, sample);
    overlay.querySelector('.htp-sec').textContent = isSilver
      ? 'Choose a silver design (HUID · Weight · Purity · Metal — tag number on the other side, no QR)'
      : 'Choose a design (all show Article · HUID · Weight · Purity · QR · Centre)';
    const detailDefs = isSilver ? silverDefs : [
      {id:'d1',name:'Bordered grid',rec:true},
      {id:'d2',name:'Header bar'},
      {id:'d3',name:'Big HUID'},
      {id:'d4',name:'Labeled box'},
      {id:'d5',name:'Minimal'},
    ];

    // Pre-build every printable tag's payload (with its real QR matrix) so the
    // list shows the exact QR that will be printed, and Print All reuses them.
    let sampleQR = null;
    const payloads = [];
    for (const t of printable) {
      const pl = await buildPayload(t, data.jobcardNo, selPurity, selDetail);
      payloads.push({ tag: t, pl });
      if (!sampleQR) sampleQR = pl.qr_rows;
    }

    function paintCards() {
      overlay.querySelector('#htpDetailCards').innerHTML = detailDefs.map(c => `
        <div class="htp-card ${selDetail===c.id?'sel':''}" data-d="${c.id}">
          <div class="htp-card-top"><span>${c.name}</span>${c.rec?'<em>Recommended</em>':'<i class="chk"></i>'}</div>
          <div class="htp-card-prev">${previewFor(c.id)}</div>
        </div>`).join('');
      overlay.querySelectorAll('[data-d]').forEach(el => el.onclick = () => { selDetail = el.dataset.d; paintCards(); paintFinal(); });
    }
    function paintFinal() {
      if (isSilver) {
        const boxed = selDetail === 's2' || selDetail === 's4';
        overlay.querySelector('#htpFinal').innerHTML = `
        <div class="htp-tag">
          <div class="htp-tag-l">${silverPreviewHTML(selDetail, sample)}</div>
          <div class="htp-tag-fold"><div class="htp-tag-hole"></div></div>
          <div class="htp-tag-r" style="display:flex;flex-direction:column;justify-content:center;padding:8px 14px;font-family:Arial,Helvetica,sans-serif;color:#111;${boxed ? 'border:1.5px solid #111;' : ''}">
            <div style="font-size:9px;font-weight:700;letter-spacing:.12em;">${selDetail === 's3' ? 'TAG' : 'TAG NO.'}</div>
            <div style="font-size:26px;font-weight:800;line-height:1.1;">${sample.tagNo}</div>
          </div>
        </div>`;
        return;
      }
      const qrSvg = sampleQR ? qrRealSVG(sampleQR, 62) : qrPreviewSVG(62);
      const ctr = TAG_CONFIG.AHC_NAME.toUpperCase();
      overlay.querySelector('#htpFinal').innerHTML = `
        <div class="htp-tag">
          <div class="htp-tag-l">${detailPreviewHTML(selDetail, sample)}</div>
          <div class="htp-tag-fold"><div class="htp-tag-hole"></div></div>
          <div class="htp-tag-r htp-tag-qr">
            <div class="htp-qrbox">${qrSvg}</div>
            <div class="htp-qrside">
              <div class="htp-ctr">${ctr}</div>
              <div class="htp-serlabel">TAG - ${sample.tagNo}</div>
              <div class="htp-serlabel">Serial No.</div>
              <div class="serial">${sample.serial}</div>
            </div>
          </div>
        </div>`;
    }
    // Tags inside the From/To range (blank = open-ended on that side).
    function selected() {
      const fv = parseInt(overlay.querySelector('#htpFrom').value, 10);
      const tv = parseInt(overlay.querySelector('#htpTo').value, 10);
      const lo = isNaN(fv) ? -Infinity : fv, hi = isNaN(tv) ? Infinity : tv;
      return payloads.filter(({ tag }) => { const n = tagNum(tag); return n >= lo && n <= hi; })
        .sort((a, b) => byTagNo(a.tag, b.tag));
    }
    function paintList() {
      const list = overlay.querySelector('#htpQrList');
      const sel = selected();
      const info = overlay.querySelector('#htpRangeInfo');
      const btn = overlay.querySelector('.htp-print');
      const all = sel.length === payloads.length;
      const fv = parseInt(overlay.querySelector('#htpFrom').value, 10);
      const tv = parseInt(overlay.querySelector('#htpTo').value, 10);
      const lo = isNaN(fv) ? -Infinity : fv, hi = isNaN(tv) ? Infinity : tv;
      const notReady = data.tags.filter(t => !t.canPrint && tagNum(t) >= lo && tagNum(t) <= hi).sort(byTagNo).map(t => t.tag_id);
      info.textContent = (all ? `All ${payloads.length} tags` : `${sel.length} of ${payloads.length} tags selected`)
        + (notReady.length ? ` · not ready on portal (no HUID/weight): tag ${notReady.join(', ')}` : '');
      overlay.querySelector('#htpListHead').textContent = isSilver
        ? `Tags to print (${sel.length})`
        : `Tags to print (${sel.length}) — real QR, exactly what will print`;
      btn.textContent = all ? `Print All Tags (${sel.length})` : `Print ${sel.length} Tag${sel.length === 1 ? '' : 's'}`;
      btn.disabled = !sel.length;
      if (!payloads.length) { list.innerHTML = '<div class="htp-qrloading">No tags ready to print.</div>'; return; }
      if (!sel.length) { list.innerHTML = '<div class="htp-qrloading">No tags in this range.</div>'; return; }
      list.innerHTML = sel.map(({ tag, pl }) => `
        <div class="htp-qrrow">
          <img class="htp-qrphoto miss" data-src="${IMG_BASE}/${encodeURIComponent(pl.huid)}/article" alt="" title="Synced article photo">
          ${isSilver ? '' : `<div class="htp-qrimg">${qrRealSVG(pl.qr_rows, 64)}</div>`}
          <div class="htp-qrinfo">
            <div class="htp-qrhuid">${pl.huid}</div>
            <div class="htp-qrmeta">${(tag.article||'—')} · Wt ${wt3(tag.weight)}g · ${PURITY_LABEL[selPurity]||selPurity}</div>
            <div class="htp-qrserial">Tag ${tag.tag_id} · ${pl.serial}</div>
          </div>
        </div>`).join('');
      // Attach load/error handlers in the isolated world (page CSP may block
      // inline handlers). The thumbnail stays hidden until it actually loads.
      list.querySelectorAll('.htp-qrphoto').forEach((im) => {
        im.addEventListener('load', () => im.classList.remove('miss'));
        im.addEventListener('error', () => im.classList.add('miss'));
        im.src = im.dataset.src;
      });
    }
    paintCards(); paintFinal(); paintList();
    overlay.querySelector('#htpFrom').addEventListener('input', paintList);
    overlay.querySelector('#htpTo').addEventListener('input', paintList);

    const close = () => overlay.remove();
    overlay.querySelector('.htp-modal-x').onclick = close;
    overlay.querySelector('.htp-cancel').onclick = close;
    overlay.querySelector('.htp-print').onclick = async () => {
      if (!selected().length) return;
      const fv = parseInt(overlay.querySelector('#htpFrom').value, 10);
      const tv = parseInt(overlay.querySelector('#htpTo').value, 10);
      close();
      await printAll({ lo: isNaN(fv) ? -Infinity : fv, hi: isNaN(tv) ? Infinity : tv });
    };
  }

  // Tag number used for ordering and the From/To range: the digits in the
  // portal's AHC Tag column ("4", "N4" -> 4); the row position if it has none.
  function tagNum(t) {
    const d = String(t.tag_id || '').match(/\d+/);
    return d ? parseInt(d[0], 10) : t.position;
  }
  const byTagNo = (a, b) => (tagNum(a) - tagNum(b)) || (a.position - b.position);

  // ---- print loop ----
  // range: optional { lo, hi } tag numbers (From/To); omitted = every tag.
  // Tags print in tag-number order. A failed tag is retried once; anything
  // not printed is listed by tag number so no tag goes missing silently.
  async function printAll(range) {
    const { data } = refresh();
    const inRange = data.tags.filter(t => !range || (tagNum(t) >= range.lo && tagNum(t) <= range.hi)).sort(byTagNo);
    const printable = inRange.filter(t => t.canPrint);
    const notReady = inRange.filter(t => !t.canPrint).map(t => t.tag_id);
    if (!printable.length) {
      statusEl.innerHTML = `<span class="htp-miss">Nothing to print.${notReady.length ? ' Not ready on the portal (no HUID/weight): tag ' + notReady.join(', ') : ''}</span>`;
      return;
    }

    // Don't pretend to print when the local bridge isn't reachable.
    if (!(await bridgeAlive())) {
      warnEl.style.display = 'block';
      statusEl.innerHTML = '<span class="htp-miss">✕ Bridge server not running — start start.bat on the PC, then reload.</span>';
      return;
    }

    nextBtn.disabled = true;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const failed = []; let ok = 0, lastErr = '', mock = false;
    for (let i = 0; i < printable.length; i++) {
      const tag = printable[i];
      statusEl.textContent = `Printing ${i+1} / ${printable.length} — Tag ${tag.tag_id}`;
      let done = false;
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try {
          const r = await sendPrint(await buildPayload(tag, data.jobcardNo, selPurity, selDetail));
          if (r && r.mock) mock = true;
          ok++; done = true;
        } catch (e) {
          lastErr = (e && e.message) ? e.message : String(e);
          console.error('[TagPrinter] print failed', tag.tag_id, 'attempt', attempt, e);
          if (attempt === 1) { statusEl.textContent = `Retrying tag ${tag.tag_id}…`; await wait(1500); }
        }
      }
      if (!done) failed.push(tag.tag_id);
      await wait(600);  // printer breathing room
    }
    const skipped = notReady.length
      ? `<br><span class="htp-miss">Not printed — not ready on the portal (no HUID/weight): tag ${notReady.join(', ')}</span>` : '';
    statusEl.innerHTML = mock
      ? `<span class="htp-miss">TEST MODE — ${ok} tag(s) saved as files in the bridge's "jobs" folder, NOTHING was printed. Close the bridge window and start it with start.bat (not start-test.bat).</span>`
      : (failed.length
          ? `<span class="htp-miss">Printed ${ok}. FAILED: tag ${failed.join(', ')} — print these again. ${lastErr ? '(' + lastErr + ')' : ''}</span>`
          : `Done — ${ok} printed ✓ (tag ${printable[0].tag_id} to ${printable[printable.length - 1].tag_id})`) + skipped;
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
    // Show the "bridge not running" warning only while the bridge is really
    // down, and clear it by itself once start.bat is running (no reload needed).
    const checkBridge = async () => { warnEl.style.display = (await bridgeAlive()) ? 'none' : 'block'; };
    await checkBridge();
    setInterval(checkBridge, 5000);
    const data = scrape();
    if (!data.jobcardNo) { statusEl.textContent = 'No jobcard found on this page'; return; }
    panel.querySelector('.htp-title').textContent = `Tag Printer${METAL ? ' · ' + METAL : ''} — ${data.jobcardNo}`;
    watchTable();
    // Show every row (DataTables defaults to 10 per page) before scraping.
    expandTable(PRINT_TABLE);
    expandTable(ENTRY_TABLE);
    refresh();
    // Fallback retries: DataTables redraws async, and the table may load late.
    [400, 900, 1800, 3500].forEach(ms => setTimeout(() => { expandTable(PRINT_TABLE); refresh(); }, ms));
  })();
})();
