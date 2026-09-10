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
    const msg = [p.h, p.w, p.p, p.ac, p.dt].join('|');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(TAG_CONFIG.SIGN_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const buf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  // ---- payload for one tag ----
  async function buildPayload(tag, jobcardNo, purityCode, templateDetail, templateBarcode) {
    const serial = serialFor(jobcardNo, tag.tag_id);
    const params = {
      h: tag.huid, w: tag.weight, p: purityCode,
      ac: TAG_CONFIG.AHC_NAME, dt: new Date().toISOString().slice(0, 10)
    };
    const s = await signParams(params);
    const qs = new URLSearchParams({ ...params, s }).toString();
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
        await sendPrint(await buildPayload(tag, data.jobcardNo, selPurity, selDetail, selBarcode));
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
