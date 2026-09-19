/* Background service worker.
   Uploads tag images to Supabase Storage and checks whether a HUID is already
   synced. Runs outside the BIS page, so the page's Content-Security-Policy
   cannot block the upload request. */
importScripts('config.js');   // provides TAG_CONFIG

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);              // e.g. "image/jpeg;base64"
  const contentType = meta.split(';')[0] || 'image/jpeg';
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}

async function uploadImage(path, dataUrl) {
  const { bytes, contentType } = dataUrlToBytes(dataUrl);
  const url = `${TAG_CONFIG.SUPABASE_URL}/storage/v1/object/${TAG_CONFIG.SUPABASE_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TAG_CONFIG.SUPABASE_KEY}`,
      'apikey': TAG_CONFIG.SUPABASE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'false',      // never overwrite — images are immutable
    },
    body: bytes,
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  // 409 = already exists → treat as already synced (immutable, so that's fine).
  if (res.status === 409 || /already exists|Duplicate/i.test(text)) return { ok: true, existed: true };
  return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
}

async function huidExists(huid) {
  // A synced HUID has at least the article image. Probe its public URL.
  const url = `${TAG_CONFIG.SUPABASE_URL}/storage/v1/object/public/${TAG_CONFIG.SUPABASE_BUCKET}/${huid}/article`;
  try {
    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
    return { ok: true, exists: r.ok };
  } catch (e) {
    return { ok: true, exists: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'hd-upload') {
    uploadImage(msg.path, msg.dataUrl).then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;   // async
  }
  if (msg.type === 'hd-exists') {
    huidExists(msg.huid).then(sendResponse)
      .catch(e => sendResponse({ ok: true, exists: false }));
    return true;
  }
});
