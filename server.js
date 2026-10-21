import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(projectRoot, "node-backend/package.json"));
require("dotenv").config({ path: resolve(projectRoot, ".env") });

const express = require("express");
const cors = require("cors");
const { OAuth2Client } = require("google-auth-library");
const multer = require("multer");
const Database = require("better-sqlite3");
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const app = express();
const port = Number(process.env.PORT || 3000);
const bucketName = process.env.R2_BUCKET || "personal";
const maxFileSize = 90 * 1024 * 1024;

const databasePath = resolve(projectRoot, process.env.DATABASE_PATH || "../openframe-data/openframe.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.exec(`CREATE TABLE IF NOT EXISTS likes (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id)); CREATE INDEX IF NOT EXISTS likes_media_id_idx ON likes (media_id);`);

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleAuthClient = googleClientId ? new OAuth2Client(googleClientId) : null;

const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: "auto", endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
}) : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileSize } });

app.use(cors()); app.use(express.json({ limit: "20kb" })); app.use(express.static(projectRoot));

function safeText(value, fallback, maxLength) { const text = String(value || "").trim().slice(0, maxLength); return text || fallback; }
function extensionFor(type, name) { const fromName = String(name || "").match(/\.([a-z0-9]+)$/i); if (fromName) return fromName[1].toLowerCase(); return type.split("/")[1]; }

app.get("/api/auth/config", (req, res) => res.json({ googleClientId: googleClientId || null }));

app.post("/api/auth/google", async (req, res) => {
  if (!googleAuthClient) return res.status(503).json({ error: "Not configured" });
  try {
    const ticket = await googleAuthClient.verifyIdToken({ idToken: req.body.credential, audience: googleClientId });
    const payload = ticket.getPayload();
    res.json({ name: payload.name || payload.email, email: payload.email, picture: payload.picture || "" });
  } catch (e) { res.status(401).json({ error: "Verification failed" }); }
});

app.get("/api/likes", (req, res) => {
  const { mediaId, visitorId } = req.query;
  const count = database.prepare("SELECT COUNT(*) AS count FROM likes WHERE media_id = ?").get(mediaId).count;
  const liked = !!database.prepare("SELECT 1 FROM likes WHERE media_id = ? AND visitor_id = ?").get(mediaId, visitorId);
  res.json({ mediaId, count, liked });
});

app.post("/api/likes", (req, res) => {
  const { mediaId, visitorId } = req.body;
  const alreadyLiked = !!database.prepare("SELECT 1 FROM likes WHERE media_id = ? AND visitor_id = ?").get(mediaId, visitorId);
  if (alreadyLiked) database.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").run(mediaId, visitorId);
  else database.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)").run(mediaId, visitorId);
  res.json({ mediaId, count: database.prepare("SELECT COUNT(*) AS count FROM likes WHERE media_id = ?").get(mediaId).count, liked: !alreadyLiked });
});

app.get("/api/media", async (req, res) => {
  if (!r2) return res.status(503).json({ error: "R2 not configured" });
  try {
    const list = async (prefix) => {
      const listed = await r2.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: `${prefix}/`, MaxKeys: 1000 }));
      return Promise.all((listed.Contents || []).map(async (o) => {
        const stored = await r2.send(new HeadObjectCommand({ Bucket: bucketName, Key: o.Key }));
        const m = stored.Metadata || {};
        return { key: o.Key, type: m.kind || (prefix === "photos" ? "photo" : "video"), title: m.title || o.Key.split("/").pop(), creator: m.creator || "Anonymous", creatorPic: m.creatorpic || "", uploadedAt: m.uploadedat || o.LastModified?.toISOString(), url: `/media/${encodeURIComponent(o.Key)}` };
      }));
    };
    const [v, p] = await Promise.all([list("videos"), list("photos")]);
    res.json([...v, ...p].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
  } catch (e) { res.status(500).json({ error: "Load failed" }); }
});

app.post("/api/upload", upload.fields([{ name: "media", maxCount: 1 }, { name: "video", maxCount: 1 }]), async (req, res) => {
  if (!r2) return res.status(503).json({ error: "R2 not configured" });
  try {
    const file = req.files?.media?.[0] || req.files?.video?.[0];
    if (!file) return res.status(400).json({ error: "No file" });
    const isPhoto = file.mimetype.startsWith("image/");
    const key = `${isPhoto ? "photos" : "videos"}/${Date.now()}-${crypto.randomUUID()}.${extensionFor(file.mimetype, file.originalname)}`;
    const title = safeText(req.body.title, file.originalname, 120);
    const creator = safeText(req.body.creator, "Anonymous", 80);
    const creatorPic = safeText(req.body.creatorPic, "", 500);
    const uploadedAt = new Date().toISOString();
    await r2.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: file.buffer, ContentType: file.mimetype, Metadata: { kind: isPhoto ? "photo" : "video", title, creator, creatorpic: creatorPic, uploadedat: uploadedAt } }));
    res.status(201).json({ key, type: isPhoto ? "photo" : "video", title, creator, creatorPic, uploadedAt, url: `/media/${encodeURIComponent(key)}` });
  } catch (e) { res.status(500).json({ error: "Upload failed" }); }
});

app.get("/media/:encodedKey", async (req, res) => {
  if (!r2) return res.status(503).send("R2 not configured");
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: bucketName, Key: decodeURIComponent(req.params.encodedKey) }));
    res.setHeader("Cache-Control", "public, max-age=31536000");
    if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
    object.Body.pipe(res);
  } catch (e) { res.status(404).send("Not found"); }
});

app.listen(port, () => console.log(`Running on ${port}`));
