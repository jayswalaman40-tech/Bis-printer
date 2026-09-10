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
    // Row selector kept permissive: real portals don't always tag rows with
    // role="row", and the table may render inside <tbody> or directly under
    // <table>. Header rows use <th>, so the td.length/tagId checks skip them.
    const tbl  = document.getElementById('tabWeight');
    let rows = tbl ? tbl.querySelectorAll('tbody tr') : [];
    if (!rows.length && tbl) rows = tbl.querySelectorAll('tr');
    const tags  = [];
    rows.forEach((tr) => {
      const td = tr.querySelectorAll('td');
      if (td.length < 6) return;
      const sno     = (td[0].textContent || '').trim();
      const tagEl   = tr.querySelector('.tagIdCls');
      const tagId   = ((tagEl ? tagEl.textContent : td[1].textContent) || '').trim();
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

  // ---- keep the panel in sync with a table that loads/changes after us ----
  // The articles table often fills in via AJAX after document_idle, and the
  // portal reloads/redraws it after each weight save. Re-scan whenever it
  // mutates, and retry a few times on first load in case rows arrive late.
  function watchTable() {
    const tbl = document.getElementById('tabWeight');
    if (!tbl) return;
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; refresh(); }, 150);
    });
    obs.observe(tbl, { childList: true, subtree: true, characterData: true });
  }

  // ---- init ----
  (async function init() {
    if (!(await bridgeAlive())) { warnEl.style.display = 'block'; }
    const data = scrape();
    if (!data.jobcardNo) { statusEl.textContent = 'No jobcard found on this page'; return; }
    panel.querySelector('.htp-title').textContent = `Tag Printer — ${data.jobcardNo}`;
    refresh();
    watchTable();
    // Fallback retries for async-loaded rows (in case no mutation fires).
    [500, 1200, 2500, 5000].forEach(ms => setTimeout(refresh, ms));
  })();
})();
