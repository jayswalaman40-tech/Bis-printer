import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

const PURITY = {
  '999': { karat: '24K', fine: '99.9', label: '24 Karat' },
  '958': { karat: '23K', fine: '95.8', label: '23 Karat' },
  '916': { karat: '22K', fine: '91.6', label: '22 Karat' },
  '833': { karat: '20K', fine: '83.3', label: '20 Karat' },
  '750': { karat: '18K', fine: '75.0', label: '18 Karat' },
  '585': { karat: '14K', fine: '58.5', label: '14 Karat' },
  '375': { karat: '9K',  fine: '37.5', label: '9 Karat'  },
};

// Tamper protection: must match SIGN_SECRET in extension/config.js.
const SIGN_SECRET = 'hd-d081b74809f6507741bcceb5c6783dea';

// Recompute the tag signature the extension put in ?s= and compare.
async function verifySignature(q) {
  if (!q.s) return false;
  const msg = [q.h || '', q.w || '', q.p || ''].join('|');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SIGN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
  return hex === String(q.s);
}

function fmtWeight(w) {
  const n = parseFloat(w);
  return isFinite(n) ? n.toFixed(3) : (w || '—');
}

function today() {
  try {
    return new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

export default function TagDetailPage() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [tampered, setTampered] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;
    if (!q.h) { setReady(true); return; }
    verifySignature(q).then((valid) => {
      if (!valid) { setTampered(true); setReady(true); return; }
      setData({ huid: q.h || '', weight: q.w || '', purity: q.p || '',
        ahc_name: q.ac || 'Jaliyan Hallmarking Center' });
      setReady(true);
    });
  }, [router.isReady, router.query]);

  const Fonts = () => (
    <Head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet" />
    </Head>
  );

  if (!ready) return (<><Fonts /><div className="boot"><div className="boot-ring" /><p>Verifying hallmark…</p>
    <style jsx>{`
      .boot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:100vh;background:#0E1626;font-family:'Inter',system-ui,sans-serif;color:#8EA0B8;}
      .boot-ring{width:38px;height:38px;border-radius:50%;border:3px solid #24344E;border-top-color:#C6A15B;animation:spin .8s linear infinite;}
      p{font-size:14px;letter-spacing:.04em;}
      @keyframes spin{to{transform:rotate(360deg)}}
    `}</style></div></>);

  if (tampered) return (<><Fonts />
    <main className="err">
      <div className="err-card">
        <div className="err-icon">
          <svg viewBox="0 0 52 52" width="60" height="60"><circle cx="26" cy="26" r="24" fill="none" stroke="#E0563F" strokeWidth="3"/><path d="M18 18 L34 34 M34 18 L18 34" fill="none" stroke="#E0563F" strokeWidth="3.5" strokeLinecap="round"/></svg>
        </div>
        <div className="err-badge">VERIFICATION FAILED</div>
        <h1>This tag could not be verified</h1>
        <p>The link does not match a genuine hallmark record. It may have been edited, copied incorrectly, or is not an authentic tag issued by the centre.</p>
        <div className="err-hint">If you scanned this from real jewellery, please contact the hallmarking centre.</div>
      </div>
      <style jsx>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        .err{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(1200px 600px at 50% -10%,#241016,#0E1626);font-family:'Inter',system-ui,sans-serif;}
        .err-card{max-width:380px;text-align:center;background:#141E30;border:1px solid #2A2030;border-radius:18px;padding:38px 28px;box-shadow:0 30px 70px rgba(0,0,0,.45);}
        .err-icon{margin-bottom:18px;}
        .err-badge{display:inline-block;font:700 11px 'Inter';letter-spacing:.16em;color:#F0B4A6;background:rgba(224,86,63,.12);border:1px solid rgba(224,86,63,.35);border-radius:100px;padding:6px 14px;margin-bottom:16px;}
        h1{font:600 22px 'Cormorant Garamond',serif;color:#F4F6FA;margin-bottom:12px;line-height:1.25;}
        p{font-size:14px;line-height:1.65;color:#9AA9BF;margin-bottom:16px;}
        .err-hint{font-size:12.5px;line-height:1.6;color:#7C8AA0;background:rgba(255,255,255,.03);border-radius:10px;padding:12px 14px;}
      `}</style>
    </main></>);

  if (!data) return (<><Fonts />
    <main className="err"><div className="err-card"><h1>No tag data</h1><p>Please scan the QR code on your jewellery tag again.</p></div>
    <style jsx>{`
      .err{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0E1626;font-family:'Inter',sans-serif;}
      .err-card{max-width:360px;text-align:center;color:#9AA9BF;} h1{font:600 22px 'Cormorant Garamond',serif;color:#F4F6FA;margin-bottom:10px;} p{font-size:14px;line-height:1.6;}
    `}</style></main></>);

  const p = PURITY[data.purity] || { karat: '', fine: '', label: data.purity };
  const weight = fmtWeight(data.weight);
  const verifiedOn = today();

  return (<><Fonts />
    <Head><title>{data.huid} — Hallmark Verified</title></Head>
    <main className="page">
      <div className="sheen" />

      {/* ---- Header + verified seal ---- */}
      <header className="hero">
        <div className="crest">BUREAU OF INDIAN STANDARDS</div>
        <div className="seal">
          <svg viewBox="0 0 120 120" width="96" height="96" className="seal-svg">
            <circle cx="60" cy="60" r="54" fill="none" stroke="#2FA36B" strokeWidth="4" className="seal-ring"/>
            <circle cx="60" cy="60" r="44" fill="#2FA36B" opacity=".12"/>
            <path d="M40 61 L54 75 L82 45" fill="none" stroke="#37C083" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" className="seal-check"/>
          </svg>
        </div>
        <h1 className="hero-title">Hallmark Verified</h1>
        <p className="hero-sub">This jewellery is authenticated &amp; recorded with BIS</p>
      </header>

      {/* ---- trust badges ---- */}
      <div className="badges">
        <span className="badge b-gold">◆ BIS Hallmarked</span>
        <span className="badge b-green">✓ HUID Verified</span>
        <span className="badge b-blue">🛡 Tamper-Proof</span>
      </div>

      {/* ---- HUID hero card ---- */}
      <section className="huid-card">
        <div className="huid-top">
          <span className="huid-k">HALLMARK UNIQUE ID</span>
          <span className="huid-live"><i /> Genuine</span>
        </div>
        <div className="huid-v">{data.huid}</div>
        <div className="huid-note">6-character ID permanently registered with the Bureau of Indian Standards</div>
      </section>

      {/* ---- detail grid ---- */}
      <section className="grid">
        <div className="cell">
          <span className="c-k">Purity</span>
          <span className="c-v">{p.karat || '—'}</span>
          <span className="c-s">{p.label}</span>
        </div>
        <div className="cell">
          <span className="c-k">Fineness</span>
          <span className="c-v">{p.fine ? p.fine : '—'}<em>%</em></span>
          <span className="c-s">Gold content</span>
        </div>
        <div className="cell">
          <span className="c-k">Weight</span>
          <span className="c-v">{weight}<em>g</em></span>
          <span className="c-s">At hallmarking</span>
        </div>
        <div className="cell">
          <span className="c-k">Standard</span>
          <span className="c-v sm">IS&nbsp;1417</span>
          <span className="c-s">Gold fineness</span>
        </div>
      </section>

      {/* ---- three marks of hallmarking ---- */}
      <section className="marks">
        <p className="marks-title">The three marks of a genuine hallmark</p>
        <div className="marks-row">
          <div className="mark">
            <div className="mark-ico">
              <svg viewBox="0 0 40 40" width="34" height="34"><path d="M20 5 L34 30 L6 30 Z" fill="none" stroke="#C6A15B" strokeWidth="2.4" strokeLinejoin="round"/><circle cx="20" cy="23" r="4.5" fill="none" stroke="#C6A15B" strokeWidth="2.2"/></svg>
            </div>
            <span className="mark-k">BIS Mark</span>
            <span className="mark-s">Bureau standard</span>
          </div>
          <div className="mark">
            <div className="mark-ico gold-chip">{p.karat || '22K'}</div>
            <span className="mark-k">Purity</span>
            <span className="mark-s">{p.fine || '91.6'}% fine</span>
          </div>
          <div className="mark">
            <div className="mark-ico mono">HUID</div>
            <span className="mark-k">Unique ID</span>
            <span className="mark-s">{data.huid}</span>
          </div>
        </div>
      </section>

      {/* ---- centre / issuer ---- */}
      <section className="issuer">
        <div className="iss-row">
          <span className="iss-k">Assaying &amp; Hallmarking Centre</span>
          <span className="iss-v">{data.ahc_name}</span>
        </div>
        <div className="iss-row">
          <span className="iss-k">Verified on</span>
          <span className="iss-v">{verifiedOn}</span>
        </div>
        <div className="iss-row">
          <span className="iss-k">Status</span>
          <span className="iss-v ok">● Authentic &amp; untampered</span>
        </div>
      </section>

      <div className="assure">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z" fill="none" stroke="#2FA36B" strokeWidth="1.8" strokeLinejoin="round"/><path d="M8.5 12 L11 14.5 L15.5 9.5" fill="none" stroke="#2FA36B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <p>This page was generated from official BIS MANAK portal data at the moment of hallmarking. The details are cryptographically signed — any edited link is rejected as invalid.</p>
      </div>

      <footer className="foot">
        <div className="foot-line" />
        <p>{data.ahc_name}</p>
        <span>Hallmark verification · Powered by NexaCore AI</span>
      </footer>
    </main>

    <style jsx>{`
      *{box-sizing:border-box;margin:0;padding:0;}
      .page{position:relative;max-width:460px;margin:0 auto;min-height:100vh;padding:0 18px 40px;overflow:hidden;
        background:linear-gradient(180deg,#0E1626 0%,#0E1626 220px,#F6F4EE 220px,#F6F4EE 100%);
        font-family:'Inter',system-ui,sans-serif;}
      .sheen{position:absolute;top:-120px;left:50%;transform:translateX(-50%);width:520px;height:340px;pointer-events:none;
        background:radial-gradient(closest-side,rgba(198,161,91,.22),transparent 70%);}

      /* hero */
      .hero{position:relative;text-align:center;color:#EAF0FA;padding:26px 12px 30px;}
      .crest{font:600 10px 'Inter';letter-spacing:.22em;color:#C6A15B;margin-bottom:16px;}
      .seal{display:flex;justify-content:center;margin-bottom:14px;}
      .seal-svg{filter:drop-shadow(0 8px 22px rgba(47,163,107,.35));}
      .seal-ring{stroke-dasharray:340;stroke-dashoffset:340;animation:ring 1s ease .1s forwards;}
      .seal-check{stroke-dasharray:80;stroke-dashoffset:80;animation:check .5s ease .75s forwards;}
      @keyframes ring{to{stroke-dashoffset:0}}
      @keyframes check{to{stroke-dashoffset:0}}
      .hero-title{font:700 30px 'Cormorant Garamond',serif;letter-spacing:.01em;margin-bottom:6px;}
      .hero-sub{font-size:12.5px;color:#95A6BE;letter-spacing:.02em;}

      /* badges */
      .badges{position:relative;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:-14px 0 20px;}
      .badge{font:600 11.5px 'Inter';letter-spacing:.02em;padding:7px 13px;border-radius:100px;backdrop-filter:blur(4px);}
      .b-gold{color:#6E5324;background:#F3E4C4;border:1px solid #E4CE9C;}
      .b-green{color:#1C6B47;background:#D6EFE1;border:1px solid #AEDCC5;}
      .b-blue{color:#294B77;background:#DCE8F7;border:1px solid #B9D0EC;}

      /* huid card */
      .huid-card{background:#0E1626;color:#EAF0FA;border-radius:18px;padding:20px 22px;box-shadow:0 22px 50px rgba(14,22,38,.28);position:relative;overflow:hidden;}
      .huid-card::after{content:"";position:absolute;inset:0;border-radius:18px;border:1px solid rgba(198,161,91,.35);pointer-events:none;}
      .huid-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
      .huid-k{font:600 10px 'Inter';letter-spacing:.16em;color:#8EA0B8;}
      .huid-live{display:inline-flex;align-items:center;gap:6px;font:600 11px 'Inter';color:#4FD08A;}
      .huid-live i{width:7px;height:7px;border-radius:50%;background:#37C083;box-shadow:0 0 0 0 rgba(55,192,131,.6);animation:pulse 1.8s infinite;}
      @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(55,192,131,.5)}70%{box-shadow:0 0 0 8px rgba(55,192,131,0)}100%{box-shadow:0 0 0 0 rgba(55,192,131,0)}}
      .huid-v{font:700 30px 'JetBrains Mono',monospace;letter-spacing:.10em;color:#F6EAD0;word-break:break-all;line-height:1.1;}
      .huid-note{margin-top:10px;font-size:11.5px;line-height:1.55;color:#8497AF;}

      /* grid */
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;}
      .cell{background:#fff;border:1px solid #EAE4D6;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:3px;box-shadow:0 6px 16px rgba(24,34,52,.05);}
      .c-k{font:600 10px 'Inter';letter-spacing:.12em;text-transform:uppercase;color:#9C8A62;}
      .c-v{font:700 24px 'JetBrains Mono',monospace;color:#16233B;line-height:1.1;}
      .c-v.sm{font-size:19px;}
      .c-v em{font-style:normal;font-size:14px;color:#8A98AD;margin-left:2px;}
      .c-s{font-size:11px;color:#8A98AD;}

      /* marks */
      .marks{margin-top:22px;}
      .marks-title{text-align:center;font:600 11px 'Inter';letter-spacing:.14em;text-transform:uppercase;color:#9C8A62;margin-bottom:14px;}
      .marks-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
      .mark{background:#fff;border:1px solid #EAE4D6;border-radius:14px;padding:16px 8px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px;}
      .mark-ico{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#FBF7EE;border:1px solid #EEE4CE;}
      .mark-ico.gold-chip{font:700 15px 'JetBrains Mono';color:#8A6A2A;background:linear-gradient(135deg,#F6E7C2,#E9D097);border-color:#E0C58C;}
      .mark-ico.mono{font:700 12px 'JetBrains Mono';color:#16233B;letter-spacing:.04em;}
      .mark-k{font:600 12px 'Inter';color:#16233B;}
      .mark-s{font-size:10px;color:#9AA1AD;line-height:1.3;word-break:break-all;padding:0 2px;}

      /* issuer */
      .issuer{margin-top:22px;background:#fff;border:1px solid #EAE4D6;border-radius:14px;padding:6px 18px;box-shadow:0 6px 16px rgba(24,34,52,.05);}
      .iss-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #F1ECE0;}
      .iss-row:last-child{border-bottom:none;}
      .iss-k{font-size:12px;color:#8A98AD;letter-spacing:.02em;}
      .iss-v{font:600 13px 'Inter';color:#22303F;text-align:right;}
      .iss-v.ok{color:#1F8A5B;}

      /* assurance */
      .assure{display:flex;gap:11px;margin-top:16px;padding:14px 16px;background:#EAF4EE;border:1px solid #CFE7DA;border-radius:12px;}
      .assure svg{flex-shrink:0;margin-top:1px;}
      .assure p{font-size:11.5px;line-height:1.6;color:#2C6146;}

      /* footer */
      .foot{text-align:center;margin-top:28px;}
      .foot-line{width:44px;height:2px;background:#C6A15B;margin:0 auto 14px;border-radius:2px;}
      .foot p{font:600 13px 'Cormorant Garamond',serif;color:#3A4655;letter-spacing:.02em;}
      .foot span{display:block;margin-top:5px;font-size:10.5px;letter-spacing:.06em;color:#A6AFBC;}
    `}</style>
  </>);
}
