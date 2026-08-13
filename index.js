/**
 * Minimal backend for Asaj Perera Gallery.
 *
 * Purpose: keep the Cloudinary API secret off the browser entirely.
 * The admin dashboard (admin.html) calls this server to get a
 * short-lived, signed upload request, then uploads the actual file
 * straight to Cloudinary from the browser using that signature.
 * The secret itself never leaves this server.
 *
 * Every route requires a valid Firebase ID token AND that the
 * signed-in user's uid has a document in the Firestore `admins`
 * collection — so only your admin account can upload or delete images.
 *
 * Setup:
 *   1. cd server && npm install
 *   2. Copy .env.example to .env and fill in:
 *      - CLOUDINARY_API_SECRET (from your Cloudinary dashboard)
 *      - GOOGLE_APPLICATION_CREDENTIALS (path to a Firebase service
 *        account JSON key — Firebase Console → Project Settings →
 *        Service Accounts → Generate new private key)
 *   3. npm start
 *   4. Deploy this folder somewhere reachable over HTTPS (Render,
 *      Railway, Fly.io, a Firebase Cloud Function, your own VPS, etc.)
 *   5. In admin.html, set BACKEND_URL to that deployed URL.
 *
 * Visit /health once deployed to confirm it's actually running, and
 * /diagnostics to confirm Cloudinary + Firebase both initialized
 * correctly — this catches most "why won't uploads work" issues
 * before you even open the admin dashboard.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v2 as cloudinary } from 'cloudinary';
import admin from 'firebase-admin';

// .trim() everywhere below — a stray trailing space or newline copied from
// a dashboard/env-var UI is the #1 cause of "it just doesn't work" bugs.
function env(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : String(v).trim();
}

const CLOUDINARY_CLOUD_NAME = env('CLOUDINARY_CLOUD_NAME', 'xlpzooiq');
const CLOUDINARY_API_KEY = env('CLOUDINARY_API_KEY', '759951758839177');
const CLOUDINARY_API_SECRET = env('CLOUDINARY_API_SECRET', undefined);

if (!CLOUDINARY_API_SECRET) {
  console.error('[startup] Missing CLOUDINARY_API_SECRET environment variable. Set it in your .env file (see .env.example) or in your host\'s environment variable settings.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET
});
console.log(`[startup] Cloudinary configured for cloud_name="${CLOUDINARY_CLOUD_NAME}", api_key="${CLOUDINARY_API_KEY}"`);

// Fail loudly and clearly if Firebase Admin can't initialize, instead of
// letting every request crash later with a confusing stack trace.
let firebaseReady = false;
let firebaseInitError = null;
let db = null;
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
  db = admin.firestore();
  firebaseReady = true;
  console.log('[startup] Firebase Admin initialized successfully.');
} catch (e) {
  firebaseInitError = e.message;
  console.error('[startup] Firebase Admin FAILED to initialize:', e.message);
  console.error('[startup] Check that GOOGLE_APPLICATION_CREDENTIALS points to a valid, readable service account JSON file.');
}

const app = express();
app.use(cors());
app.use(express.json());

// Every route below is wrapped so failures always come back as JSON with
// a real message, never Express's default HTML error page — an HTML
// error page silently breaks the frontend's `.json()` parsing and shows
// up there as a vague, unhelpful failure.
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
      return res.status(500).json({ error: `Firebase Admin is not initialized: ${firebaseInitError}` });
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
    console.error('[auth] Token verification failed:', e.message);
    res.status(401).json({ error: `Invalid or expired token: ${e.message}` });
  }
}

// Quick "is it even running" check.
app.get('/health', (req, res) => res.json({ ok: true }));

// Deeper check: confirms Cloudinary config and Firebase Admin both
// actually initialized, without requiring you to be logged in. Visit
// this in a browser right after deploying to catch config problems early.
app.get('/diagnostics', (req, res) => {
  res.json({
    cloudinary: {
      cloudName: CLOUDINARY_CLOUD_NAME,
      apiKeyPresent: Boolean(CLOUDINARY_API_KEY),
      apiSecretPresent: Boolean(CLOUDINARY_API_SECRET),
      apiSecretLength: CLOUDINARY_API_SECRET ? CLOUDINARY_API_SECRET.length : 0
    },
    firebase: {
      ready: firebaseReady,
      error: firebaseInitError
    }
  });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'asaj-perera-image-backend', endpoints: ['/health', '/diagnostics', 'POST /api/cloudinary-signature', 'POST /api/cloudinary-delete'] });
});

// Issues signed params for a direct browser -> Cloudinary upload.
app.post('/api/cloudinary-signature', requireAdmin, asyncRoute(async (req, res) => {
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

// Deletes an image from Cloudinary by its public_id.
app.post('/api/cloudinary-delete', requireAdmin, asyncRoute(async (req, res) => {
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
  console.log(`Cloudinary signing server running on port ${PORT}`);
  console.log(`Try: /health, /diagnostics`);
});
