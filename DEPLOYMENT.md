# Deploying the image backend (Render / similar hosts)

This backend signs Cloudinary uploads and handles deletes on behalf of the admin dashboard. It must be reachable over HTTPS by the admin app (admin.html) and requires the following environment variables to be set in your host dashboard.

Required environment variables (set these in Render's Dashboard → Environment)

- CLOUDINARY_API_SECRET — Your Cloudinary API secret (sensitive). Without this, the server will start but signing endpoints will return 503 until you set it.
- CLOUDINARY_API_KEY — Your Cloudinary API key (not secret, but recommended).
- CLOUDINARY_CLOUD_NAME — Your Cloudinary cloud name.

Firebase Admin credentials (choose one approach)

A) GOOGLE_SERVICE_ACCOUNT_JSON (recommended on Render)
- Set this to the JSON contents of your Firebase service account key. For safety and convenience you can base64-encode the JSON and set the base64 string as the env var.
- The server will accept either raw JSON or base64-encoded JSON in this env var and initialize Firebase Admin with it.

B) GOOGLE_APPLICATION_CREDENTIALS (file path)
- If your host supports uploading files and exposing them on disk, set this env var to the path of the JSON file.

How to verify after deployment

1. Visit /health
   - Should return: { "ok": true, "ts": 123456789 }
2. Visit /diagnostics
   - Should return a JSON object showing:
     - cloudinary.configured: true or false
     - firebase.ready: true or false
   - If cloudinary.configured=false, set CLOUDINARY_API_SECRET and redeploy.
   - If firebase.ready=false, ensure you provided credentials (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS).

Testing the signing endpoint

- After logging in as an admin in admin.html (or obtaining a Firebase ID token for an admin user), POST to /api/cloudinary-signature with Authorization: Bearer <idToken> and JSON body { "folder":"siteImages" }.
- If Cloudinary is configured and your token is valid, you'll receive { signature, timestamp, apiKey, cloudName, folder }.
- If Cloudinary is not configured you'll receive 503 with an explanatory message.

Security notes

- Never commit CLOUDINARY_API_SECRET or your Firebase service account JSON to source control. Use your host's environment variable feature.
- The server intentionally does not exit when configuration is missing; this ensures health checks and diagnostics are available so you can correct configuration without guesswork.
