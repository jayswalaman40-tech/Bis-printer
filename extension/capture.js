/* ================================================================
   HALLMARK IMAGE SYNC — Capture-Image page (BIS MANAK)
   Detects the per-HUID "Image" page, and syncs its Article + HUID
   photos to the image server (Supabase). Once synced, images live on
   the server permanently (no unsync).
   ================================================================ */
(function () {
  // ---- detect the per-HUID Image page ----
  // It has the HUID image table (#tabPrintHUID) and a hidden uidId (the HUID).
  const table = document.getElementById('tabPrintHUID');
  const uidEl = document.querySelector('input[name="uidId"]');
  if (!table || !uidEl) return;

  const b64 = (v) => { try { return atob((v || '').trim()); } catch { return (v || '').trim(); } };
  const HUID = b64(uidEl.value).trim();
  if (!HUID) return;

  const jobNo  = b64((document.querySelector('input[name="jobNo"]')     || {}).value);
  const tagId  = b64((document.querySelector('input[name="tagId"]')     || {}).value);
  const reqNo  = b64((document.querySelector('input[name="requestNo"]') || {}).value);

  // ---- find the Article + HUID image links (viewImage?...) ----
  function findImages() {
    const links = Array.from(table.querySelectorAll('a[href*="viewImage"]'));
    const out = [];
    links.forEach((a) => {
      const label = (a.textContent || '').trim().toLowerCase();
      const kind = label.includes('huid') ? 'huid' : 'article';
      out.push({ kind, url: a.href });
    });
    // De-dupe by kind (keep first of each).
    const seen = {}; const res = [];
    for (const o of out) { if (!seen[o.kind]) { seen[o.kind] = 1; res.push(o); } }
    return res;
  }

  // ---- fetch an image as a data URL (handles viewImage returning HTML) ----
  async function fetchImageDataURL(url) {
    const r = await fetch(url, { credentials: 'include' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('image/')) return blobToDataURL(await r.blob());
    // viewImage returned an HTML page — dig out the real image.
    const txt = await r.text();
    let m = txt.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) {
      let u = m[1];
      if (u.startsWith('data:')) return u;
      u = new URL(u, url).href;
      const r2 = await fetch(u, { credentials: 'include' });
      return blobToDataURL(await r2.blob());
    }
    m = txt.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/i);
    if (m) return m[0];
    throw new Error('image not found');
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  function upload(path, dataUrl) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'hd-upload', path, dataUrl }, resolve);
    });
  }

  // ---- panel ----
  const panel = document.createElement('div');
  panel.className = 'hdimg-panel';
  panel.innerHTML = `
    <div class="hdimg-head">
      <span class="hdimg-dot"></span>
      <span class="hdimg-title">Image Sync</span>
    </div>
    <div class="hdimg-body">
      <div class="hdimg-huid">HUID <b>${HUID}</b></div>
      <div class="hdimg-sub">Tag ${tagId || '—'} · Job ${jobNo || '—'}</div>
      <div class="hdimg-thumbs" id="hdimgThumbs"></div>
      <button class="hdimg-sync" id="hdimgSync">Sync images to server</button>
      <p class="hdimg-status" id="hdimgStatus"></p>
    </div>`;
  document.body.appendChild(panel);

  const statusEl = panel.querySelector('#hdimgStatus');
  const btn = panel.querySelector('#hdimgSync');
  const thumbs = panel.querySelector('#hdimgThumbs');

  const imgs = findImages();
  thumbs.innerHTML = imgs.map(o =>
    `<span class="hdimg-chip">${o.kind === 'huid' ? 'HUID photo' : 'Article photo'}</span>`).join('');
  if (!imgs.length) {
    statusEl.textContent = 'No Article/HUID image found on this page.';
    btn.disabled = true;
  }

  // Already synced?
  chrome.runtime.sendMessage({ type: 'hd-exists', huid: HUID }, (res) => {
    if (res && res.exists) {
      btn.textContent = 'Synced ✓ — sync again';
      statusEl.innerHTML = '<span class="ok">Already on server ✓</span>';
    }
  });

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
    if (fail === 0) {
      btn.textContent = 'Synced ✓';
      statusEl.innerHTML = `<span class="ok">Done — ${ok} image(s) saved on server ✓</span>`;
    } else {
      btn.disabled = false;
      statusEl.innerHTML = `<span class="err">Saved ${ok}, failed ${fail}. ${lastErr}</span>`;
    }
  };
})();
