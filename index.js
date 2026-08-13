import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v2 as cloudinary } from 'cloudinary';
import admin from 'firebase-admin';

// Helper to read envs safely
function env(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : String(v).trim();
}

/* -------------------------
   Cloudinary config (may be absent)
   ------------------------- */
const CLOUDINARY_CLOUD_NAME = env('CLOUDINARY_CLOUD_NAME', 'xlpzooiq');
const CLOUDINARY_API_KEY = env('CLOUDINARY_API_KEY', '759951758839177');
const CLOUDINARY_API_SECRET = env('CLOUDINARY_API_SECRET', undefined);

let cloudinaryConfigured = false;
if (CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
  cloudinaryConfigured = true;
  console.log(`[startup] Cloudinary configured for cloud_name="${CLOUDINARY_CLOUD_NAME}", api_key_present=${Boolean(CLOUDINARY_API_KEY)}`);
} else {
  console.warn('[startup] CLOUDINARY_API_SECRET not provided — Cloudinary signing endpoints will be disabled until you set this env var.');
}

/* -------------------------
   Firebase Admin init (robust)
   - Tries GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64)
   - Falls back to applicationDefault if available
   ------------------------- */
let firebaseReady = false;
let firebaseInitError = null;
let db = null;

function tryParseServiceAccountEnv() {
  const raw = env('GOOGLE_SERVICE_ACCOUNT_JSON', '');
  if (!raw) return null;
  try {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return JSON.parse(trimmed);
  } catch (e) {
    console.warn('[startup] GOOGLE_SERVICE_ACCOUNT_JSON provided but could not parse it as JSON.');
    return null;
  }
}

try {
  const sa = tryParseServiceAccountEnv();
  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
    firebaseReady = true;
    console.log('[startup] Firebase Admin initialized using GOOGLE_SERVICE_ACCOUNT_JSON.');
  } else {
    try {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      db = admin.firestore();
      firebaseReady = true;
      console.log('[startup] Firebase Admin initialized using Application Default Credentials.');
    } catch (e2) {
      firebaseInitError = e2.message || String(e2);
      firebaseReady = false;
      console.warn('[startup] Firebase Admin NOT initialized:', firebaseInitError);
    }
  }
} catch (e) {
  firebaseInitError = e.message || String(e);
  firebaseReady = false;
  console.warn('[startup] Firebase Admin initialization failed:', firebaseInitError);
}

/* -------------------------
   Express app
   ------------------------- */
const app = express();
app.use(cors());
app.use(express.json());

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error(`[error] ${req.method} ${req.path}:`, e);
      if (!res.headersSent) res.status(500).json({ error: e.message || 'Internal server error' });
    });
  };
}

async function requireAdmin(req, res, next) {
  try {
    if (!firebaseReady) {
      return res.status(500).json({ error: `Firebase Admin is not initialized: ${firebaseInitError || 'unknown'}` });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization bearer token' });

    const decoded = await admin.auth().verifyIdToken(token);
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: `Not authorized as admin (uid ${decoded.uid} has no matching document in the "admins" collection)` });
    }

    req.uid = decoded.uid;
    next();
  } catch (e) {
    console.error('[auth] Token verification failed:', e && e.message ? e.message : e);
    return res.status(401).json({ error: `Invalid or expired token: ${e && e.message ? e.message : String(e)}` });
  }
}

/* -------------------------
   Health & diagnostics
   ------------------------- */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/diagnostics', (req, res) => {
  res.json({
    cloudinary: {
      cloudName: CLOUDINARY_CLOUD_NAME || null,
      apiKeyPresent: Boolean(CLOUDINARY_API_KEY),
      apiSecretPresent: Boolean(CLOUDINARY_API_SECRET),
      configured: cloudinaryConfigured
    },
    firebase: {
      ready: firebaseReady,
      error: firebaseInitError
    },
    node: {
      version: process.version,
      env: process.env.NODE_ENV || 'development'
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'asaj-perera-image-backend',
    cloudinaryConfigured,
    firebaseReady,
    endpoints: ['/health', '/diagnostics', 'POST /api/cloudinary-signature', 'POST /api/cloudinary-delete']
  });
});

/* -------------------------
   Cloudinary signing and delete routes
   If Cloudinary not configured, return 503 to indicate operator action needed.
   ------------------------- */
app.post('/api/cloudinary-signature', requireAdmin, asyncRoute(async (req, res) => {
  if (!cloudinaryConfigured) {
    return res.status(503).json({ error: 'Cloudinary signing is not configured on this server. Set CLOUDINARY_API_SECRET (and related vars) in your host environment.' });
  }

  const folder = (req.body && req.body.folder) ? String(req.body.folder).slice(0, 100) : 'uploads';
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = { timestamp, folder };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, CLOUDINARY_API_SECRET);

  res.json({
    signature,
    timestamp,
    apiKey: CLOUDINARY_API_KEY,
    cloudName: CLOUDINARY_CLOUD_NAME,
    folder
  });
}));

app.post('/api/cloudinary-delete', requireAdmin, asyncRoute(async (req, res) => {
  if (!cloudinaryConfigured) {
    return res.status(503).json({ error: 'Cloudinary delete is not configured on this server. Set CLOUDINARY_API_SECRET (and related vars) in your host environment.' });
  }

  const { publicId } = req.body || {};
  if (!publicId) return res.status(400).json({ error: 'publicId is required' });
  const result = await cloudinary.uploader.destroy(publicId);
  res.json({ success: true, result });
}));

// Catch-all for unknown routes, still as JSON.
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Cloudinary signing server running on port ${PORT} (cloudinaryConfigured=${cloudinaryConfigured}, firebaseReady=${firebaseReady})`);
  console.log(`Try: /health, /diagnostics`);
});
