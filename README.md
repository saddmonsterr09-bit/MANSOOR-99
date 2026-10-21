# Reels Book 🔥

A public photo and video wall with uploads stored in Cloudflare R2 and shared likes stored in SQLite.

## Deploy to Cloudflare Workers

1. Open the Cloudflare Worker project and use the repository root as its working directory.
2. Leave the build command empty. Set the deploy command to `npx wrangler deploy`.
3. The Worker configuration is in `wrangler.jsonc`; it uses `cloudflare-worker.js` as its entry point.
4. Set `GOOGLE_CLIENT_ID` as a Worker variable if you want Google sign-in and uploads. It is not needed to build or deploy the Worker.

The root `package.json` intentionally has no Node server dependencies, so the Worker build does not try to install native Node packages such as `better-sqlite3`.

## Run the optional Node.js backend

1. Use Node.js 20 or newer.
2. Install dependencies with `npm --prefix node-backend install`.
3. Copy `.env.example` to `.env` and add your Cloudflare R2 endpoint and credentials.
4. Start the server with `npm --prefix node-backend start`.
5. Open the app at `http://localhost:3000`.

The Node.js server serves the website and API. Keep R2 credentials in server environment variables; never commit `.env` to GitHub.

## Google sign-in for uploads

Visitors can browse the wall and watch videos without signing in. Uploads require Google sign-in; the server verifies Google's ID token before accepting an upload.

Set `GOOGLE_CLIENT_ID` in the Node.js host environment and in `.env` for local development. For Cloudflare Workers, configure the same value as a Worker variable named `GOOGLE_CLIENT_ID`. Create an OAuth 2.0 Client ID of type **Web application** in Google Cloud Console, add the website origin to **Authorized JavaScript origins** (and your local development origin when needed), then use that client ID. Do not put a client secret in browser code. Restart/redeploy the Node.js app or Worker after setting the variable. Until configured, upload sign-in stays unavailable.

## Photo and video uploads


Visitors can upload photos (JPEG, PNG, WebP, GIF, AVIF) and videos (MP4, MOV, WebM, OGG, MKV). Individual files can be up to 90 MB. Uploads are stored in the configured R2 bucket in separate `photos/` and `videos/` prefixes. The `/api/media` endpoint lists both kinds of media, and `/api/upload` accepts them.

R2 retains the uploaded objects unless you or your storage provider remove them or configure a lifecycle rule. Make sure the R2 bucket and credentials remain active. R2 API credentials belong in the Node host's environment settings, not in the browser or GitHub repository.

## Featured image

The home page displays `/SAD.jpg`. Add your actual `SAD.jpg` image to the project root and commit it to GitHub. The file should be named exactly `SAD.jpg` (capital letters included).

## R2 setup

Set the following server environment variables:

- `R2_BUCKET`: R2 bucket name (defaults to `personal`)
- `R2_ENDPOINT`: your Cloudflare account's R2 S3 endpoint
- `R2_ACCESS_KEY_ID`: R2 access key ID
- `R2_SECRET_ACCESS_KEY`: R2 secret access key

The R2 token needs permission to list, read, and write objects in the selected bucket.

## Shared likes and persistence

Likes for featured images, photos, and videos are stored in SQLite, with one like per visitor ID and media item. The count is read from the server, so visitors see a shared count. The browser's visitor ID is retained locally to remember whether that browser has liked an item.

Set `DATABASE_PATH` to a location on persistent disk provided by your Node.js host. The default is `../openframe-data/openframe.sqlite`. Use a single Node.js instance with persistent storage for SQLite. If your host has an ephemeral filesystem or runs multiple app instances, use a shared database such as PostgreSQL instead.

## Deployment note

This project needs a Node.js host to run the backend (`server.js`). A static-only website deployment will not run the upload and like APIs. Deploy the Node app and set its R2 and persistent database environment variables on the hosting service.
