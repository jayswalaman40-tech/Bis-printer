/* BIS Page Inspector — TEMPORARY, read-only.
   Shows a floating box with the page's image structure so we can build the
   image-sync scraper. It does NOT change anything on the BIS page. */
(function () {
  if (window.__bisInspectorLoaded) return;
  window.__bisInspectorLoaded = true;

  function nearText(el) {
    let node = el, out = '';
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) { out = t.slice(0, 120); break; }
    }
    return out;
  }
  function ancestorHTML(el) {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const p = node.parentElement;
      if (!p) break;
      if (/^(TR|LI|TD)$/.test(p.tagName) || (p.className && /row|card|col-|item|image|img|article|huid/i.test(p.className))) {
        return p.outerHTML.slice(0, 900);
      }
      node = p;
    }
    return (el.parentElement ? el.parentElement.outerHTML : el.outerHTML).slice(0, 900);
  }

  function collect() {
    const imgs = Array.from(document.images || []);
    const report = {
      url: location.href,
      title: document.title,
      imageCount: imgs.length,
      images: imgs.map((im, i) => ({
        i,
        src: im.getAttribute('src') || '',
        currentSrc: im.currentSrc || '',
        alt: im.alt || '',
        id: im.id || '',
        cls: im.className || '',
        w: im.naturalWidth, h: im.naturalHeight,
        near: nearText(im),
        ctx: ancestorHTML(im)
      }))
      // Skip tiny UI icons (logo/avatar) to keep the dump focused on real photos.
      .filter(o => !/bis_logo|favicon|ShowImage\b/.test(o.src) || o.w > 120)
    };
    // Also list any obvious HUID-looking tokens on the page (6-char alnum).
    const body = (document.body.innerText || '');
    const huids = Array.from(new Set((body.match(/\b[A-Z0-9]{6}\b/g) || []))).slice(0, 40);
    report.possibleHUIDs = huids;
    // Input fields (jobcard etc.)
    report.inputs = Array.from(document.querySelectorAll('input,select'))
      .map(e => ({ id: e.id, name: e.name, type: e.type, val: (e.value || '').slice(0, 40) }))
      .filter(e => e.id || e.name).slice(0, 40);
    return report;
  }

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:420px;max-width:92vw;background:#0E1626;color:#EAF0FA;border:1px solid #C6A15B;border-radius:10px;font-family:system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5);';
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #24344E;">' +
    '<b style="font-size:13px;flex:1">BIS Page Inspector</b>' +
    '<button id="bisCopy" style="background:#C6A15B;border:none;color:#1B2430;font-weight:700;border-radius:5px;padding:6px 10px;cursor:pointer">Copy</button>' +
    '<button id="bisClose" style="background:transparent;border:1px solid #55627a;color:#cbd4e2;border-radius:5px;padding:6px 9px;cursor:pointer">X</button></div>' +
    '<div style="padding:8px 12px;font-size:11px;color:#9fb0c6">Neeche wala saara text copy karke Claude ko bhej do.</div>' +
    '<textarea id="bisOut" readonly style="width:100%;height:220px;box-sizing:border-box;border:none;border-top:1px solid #24344E;background:#0b1220;color:#cfe0f5;font:11px/1.4 monospace;padding:10px;resize:vertical"></textarea>';
  document.documentElement.appendChild(box);

  const ta = box.querySelector('#bisOut');
  function refresh() { ta.value = JSON.stringify(collect(), null, 1); }
  refresh();
  // Images may load a moment later — refresh a few times.
  [800, 2000, 4000].forEach(ms => setTimeout(refresh, ms));

  box.querySelector('#bisCopy').onclick = () => {
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    try { navigator.clipboard && navigator.clipboard.writeText(ta.value); } catch (e) {}
    box.querySelector('#bisCopy').textContent = 'Copied';
    setTimeout(() => { box.querySelector('#bisCopy').textContent = 'Copy'; }, 1500);
  };
  box.querySelector('#bisClose').onclick = () => box.remove();
})();
