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
  // Which metal this extension prints: 'Gold' or 'Silver' (anything else, or
  // blank, offers both). Install one Gold and one Silver copy if needed.
  METAL:       '',

  // Tamper protection: each tag URL is signed with this secret and the
  // verification page re-checks it, so an edited URL shows "Invalid tag".
  // MUST match SIGN_SECRET in the website (website/pages/tag/index.jsx).
  // Change it to your own value before handing over to a customer.
  SIGN_SECRET: 'hd-d081b74809f6507741bcceb5c6783dea',

  // ---- Image server (Supabase Storage) ----
  // The Capture-Image page syncs each HUID's Article + HUID photos here, and
  // the verification website loads them back by HUID. Bucket is immutable
  // (public read, insert only — synced images can't be changed or deleted).
  SUPABASE_URL:    'https://dkufqwkyrdponsaekshv.supabase.co',
  SUPABASE_KEY:    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrdWZxd2t5cmRwb25zYWVrc2h2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NTc1NTgsImV4cCI6MjA5ODIzMzU1OH0.4oSBrR2_SjmL-rfcqrjiPIaxaCnX85Vkx7ttecHmSq4',
  SUPABASE_BUCKET: 'bistags',
};

// Public base URL for reading a synced image: `${IMG_BASE}/<HUID>/article`.
const IMG_BASE = `${TAG_CONFIG.SUPABASE_URL}/storage/v1/object/public/${TAG_CONFIG.SUPABASE_BUCKET}`;
