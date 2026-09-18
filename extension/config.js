/* ================================================================
   HALLMARK TAG PRINTER — per-customer configuration
   Edit these values for each Assaying & Hallmarking Centre (AHC).
   ================================================================ */
const TAG_CONFIG = {
  BRIDGE_URL:  'http://localhost:7072',
  // Short path-form base keeps the printed QR small enough to scan reliably
  // on the narrow tag: https://<host>/t/<huid>/<weight>/<purity>/<sig>
  DETAIL_BASE: 'https://jhcv-five.vercel.app/t',
  AHC_NAME:    'Jaliyan Hallmarking Center',   // per-customer
  AHC_CODE:    'SHC001',                        // per-customer

  // Tamper protection: each tag URL is signed with this secret and the
  // verification page re-checks it, so an edited URL shows "Invalid tag".
  // MUST match SIGN_SECRET in the website (website/pages/tag/index.jsx).
  // Change it to your own value before handing over to a customer.
  SIGN_SECRET: 'hd-d081b74809f6507741bcceb5c6783dea',
};
