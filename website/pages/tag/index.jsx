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
