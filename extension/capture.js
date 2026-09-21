/* ================================================================
   HALLMARK IMAGE SYNC — BIS MANAK image pages
   Two pages are handled:
   (A) Jobcard HUID LIST page (#tabPrintHUID rows with "uploadedImageView"
       links)  -> one "Sync all tags" button syncs every tag's Article +
       HUID photos to the server (Supabase).
   (B) Single per-HUID image page (input[name=uidId] + "viewImage" links)
       -> syncs just that one HUID.
   Once synced, images stay on the server permanently (no unsync).
   ================================================================ */
(function () {
  const b64 = (v) => { try { return decodeURIComponent(escape(atob((v || '').trim()))); } catch { try { return atob((v || '').trim()); } catch { return (v || '').trim(); } } };

  // ---- shared helpers ----
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  // Fetch a viewImage URL as a data URL (handles it returning an HTML page).
  async function fetchImageDataURL(url) {
    const r = await fetch(url, { credentials: 'include' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('image/')) return blobToDataURL(await r.blob());
    const txt = await r.text();
    let m = txt.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) {
      let u = m[1];
      if (u.startsWith('data:')) return u;
      u = new URL(u.replace(/\s+/g, ''), url).href;
      const r2 = await fetch(u, { credentials: 'include' });
      return blobToDataURL(await r2.blob());
    }
    m = txt.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/i);
    if (m) return m[0];
    throw new Error('image not found');
  }
  function upload(path, dataUrl) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'hd-upload', path, dataUrl }, resolve));
  }
  function exists(huid) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'hd-exists', huid }, (r) => resolve(!!(r && r.exists))));
  }
  // From a per-HUID image page (HTML string), get the two image links.
  function imagesFromPage(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = []; const seen = {};
    doc.querySelectorAll('a[href*="viewImage"]').forEach((a) => {
      const label = (a.textContent || '').trim().toLowerCase();
      const kind = label.includes('huid') ? 'huid' : 'article';
      if (seen[kind]) return;
      seen[kind] = 1;
      out.push({ kind, url: new URL(a.getAttribute('href').replace(/\s+/g, ''), baseUrl).href });
    });
    return out;
  }
  // Sync one tag: fetch its image page, then upload both photos.
  async function syncOneTag(huid, pageUrl) {
    const r = await fetch(pageUrl, { credentials: 'include' });
    const html = await r.text();
    const imgs = imagesFromPage(html, pageUrl);
    if (!imgs.length) throw new Error('no images on tag page');
    for (const o of imgs) {
      const dataUrl = await fetchImageDataURL(o.url);
      const res = await upload(`${huid}/${o.kind}`, dataUrl);
      if (!(res && res.ok)) throw new Error((res && res.error) || 'upload failed');
    }
  }

  // ================= (A) Jobcard LIST page =================
  const listTable = document.getElementById('tabPrintHUID');
  const listLinks = listTable ? listTable.querySelectorAll('a[href*="uploadedImageView"]') : [];
  if (listTable && listLinks.length) {
    // Build the tag list from the "View" links (each carries uidId=HUID + params).
    const tags = [];
    listLinks.forEach((a) => {
      const href = new URL(a.getAttribute('href').replace(/\s+/g, ''), location.href).href;
      const u = new URL(href);
      const huid = b64(u.searchParams.get('uidId') || '');
      if (huid) tags.push({ huid, url: href });
    });
    const jobNo = b64((document.querySelector('input[name="str_job_no"]') || {}).value || '');

    const panel = document.createElement('div');
    panel.className = 'hdimg-panel';
    panel.innerHTML = `
      <div class="hdimg-head"><span class="hdimg-dot"></span><span class="hdimg-title">Image Sync — Jobcard</span></div>
      <div class="hdimg-body">
        <div class="hdimg-huid">Job <b>${jobNo || '—'}</b></div>
        <div class="hdimg-sub">${tags.length} tag(s) is jobcard me</div>
        <div class="hdimg-progress" id="hdP" style="display:none"><i></i></div>
        <button class="hdimg-sync" id="hdSyncAll">Sync all tags (${tags.length})</button>
        <p class="hdimg-status" id="hdS"></p>
      </div>`;
    document.body.appendChild(panel);

    const btn = panel.querySelector('#hdSyncAll');
    const statusEl = panel.querySelector('#hdS');
    const prog = panel.querySelector('#hdP');
    const bar = prog.querySelector('i');
    if (!tags.length) { btn.disabled = true; statusEl.textContent = 'No uploaded images found for this jobcard.'; }

    btn.onclick = async () => {
      btn.disabled = true;
      prog.style.display = 'block';
      let done = 0, skip = 0, fail = 0, lastErr = '';
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        statusEl.innerHTML = `Syncing ${i + 1} / ${tags.length} — <b>${t.huid}</b>`;
        bar.style.width = Math.round((i / tags.length) * 100) + '%';
        try {
          if (await exists(t.huid)) { skip++; }
          else { await syncOneTag(t.huid, t.url); done++; }
        } catch (e) { fail++; lastErr = String(e && e.message || e); }
      }
      bar.style.width = '100%';
      statusEl.innerHTML = fail
        ? `<span class="err">Done — ${done} synced, ${skip} already, ${fail} failed. ${lastErr}</span>`
        : `<span class="ok">Done ✓ — ${done} synced, ${skip} already on server.</span>`;
      btn.disabled = false;
      btn.textContent = 'Sync again';
    };
    return;   // list page handled — don't run the single-page logic
  }

  // ================= (B) Single per-HUID image page =================
  const uidEl = document.querySelector('input[name="uidId"]');
  const table = document.getElementById('tabPrintHUID');
  if (!table || !uidEl) return;
  const HUID = b64(uidEl.value).trim();
  if (!HUID) return;
  const jobNo = b64((document.querySelector('input[name="jobNo"]') || {}).value);
  const tagId = b64((document.querySelector('input[name="tagId"]') || {}).value);

  const imgs = [];
  { const seen = {};
    table.querySelectorAll('a[href*="viewImage"]').forEach((a) => {
      const kind = (a.textContent || '').trim().toLowerCase().includes('huid') ? 'huid' : 'article';
      if (seen[kind]) return; seen[kind] = 1;
      imgs.push({ kind, url: a.href });
    });
  }

  const panel = document.createElement('div');
  panel.className = 'hdimg-panel';
  panel.innerHTML = `
    <div class="hdimg-head"><span class="hdimg-dot"></span><span class="hdimg-title">Image Sync</span></div>
    <div class="hdimg-body">
      <div class="hdimg-huid">HUID <b>${HUID}</b></div>
      <div class="hdimg-sub">Tag ${tagId || '—'} · Job ${jobNo || '—'}</div>
      <div class="hdimg-thumbs">${imgs.map(o => `<span class="hdimg-chip">${o.kind === 'huid' ? 'HUID photo' : 'Article photo'}</span>`).join('')}</div>
      <button class="hdimg-sync" id="hdSync">Sync images to server</button>
      <p class="hdimg-status" id="hdS"></p>
    </div>`;
  document.body.appendChild(panel);
  const btn = panel.querySelector('#hdSync');
  const statusEl = panel.querySelector('#hdS');
  if (!imgs.length) { btn.disabled = true; statusEl.textContent = 'No Article/HUID image found on this page.'; }

  exists(HUID).then((ex) => { if (ex) { btn.textContent = 'Synced ✓ — sync again'; statusEl.innerHTML = '<span class="ok">Already on server ✓</span>'; } });

  btn.onclick = async () => {
    btn.disabled = true;
    let ok = 0, fail = 0, lastErr = '';
    for (const o of imgs) {
      statusEl.textContent = `Uploading ${o.kind === 'huid' ? 'HUID' : 'Article'} image…`;
      try {
        const dataUrl = await fetchImageDataURL(o.url);
        const r = await upload(`${HUID}/${o.kind}`, dataUrl);
        if (r && r.ok) ok++; else { fail++; lastErr = (r && r.error) || 'upload failed'; }
      } catch (e) { fail++; lastErr = String(e && e.message || e); }
    }
    if (fail === 0) { btn.textContent = 'Synced ✓'; statusEl.innerHTML = `<span class="ok">Done — ${ok} image(s) saved ✓</span>`; }
    else { btn.disabled = false; statusEl.innerHTML = `<span class="err">Saved ${ok}, failed ${fail}. ${lastErr}</span>`; }
  };
})();
