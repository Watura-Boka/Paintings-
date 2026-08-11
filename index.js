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
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v2 as cloudinary } from 'cloudinary';
import admin from 'firebase-admin';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'xlpzooiq';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '759951758839177';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUDINARY_API_SECRET) {
  console.error('Missing CLOUDINARY_API_SECRET environment variable. Set it in your .env file (see .env.example).');
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET
});

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization bearer token' });

    const decoded = await admin.auth().verifyIdToken(token);
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) return res.status(403).json({ error: 'Not authorized as admin' });

    req.uid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Issues signed params for a direct browser -> Cloudinary upload.
app.post('/api/cloudinary-signature', requireAdmin, (req, res) => {
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
});

// Deletes an image from Cloudinary by its public_id.
app.post('/api/cloudinary-delete', requireAdmin, async (req, res) => {
  const { publicId } = req.body || {};
  if (!publicId) return res.status(400).json({ error: 'publicId is required' });
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Cloudinary signing server running on port ${PORT}`));
