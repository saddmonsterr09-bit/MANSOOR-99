import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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

database.exec(`
CREATE TABLE IF NOT EXISTS likes (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id));
CREATE INDEX IF NOT EXISTS likes_media_id_idx ON likes (media_id);
CREATE TABLE IF NOT EXISTS media_views (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id));
CREATE INDEX IF NOT EXISTS media_views_media_id_idx ON media_views (media_id);
CREATE TABLE IF NOT EXISTS watch_events (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS watch_events_media_id_idx ON watch_events (media_id);
CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, from_email TEXT NOT NULL, to_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(from_email, to_email));
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_email, status);
CREATE INDEX IF NOT EXISTS friend_requests_from_idx ON friend_requests (from_email, status);
CREATE TABLE IF NOT EXISTS friendships (user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_a, user_b));
CREATE INDEX IF NOT EXISTS friendships_a_idx ON friendships (user_a);
CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships (user_b);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_email TEXT NOT NULL, to_email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT);
CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages (from_email, to_email, created_at);
CREATE TABLE IF NOT EXISTS user_interests (visitor_id TEXT NOT NULL, tag TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (visitor_id, tag));
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, picture TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleAuthClient = googleClientId ? new OAuth2Client(googleClientId) : null;

const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: "auto", endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
}) : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileSize } });
app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(express.static(projectRoot));

function safeText(v, f, m) { const t = String(v || "").trim().slice(0, m); return t || f; }
function extensionFor(type, name) {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return type.split("/")[1];
}
function normEmail(e) { return String(e || "").trim().toLowerCase(); }

const mediaCache = { data: null, ts: 0 };
const MEDIA_CACHE_MS = 30 * 1000;

app.get("/api/auth/config", (req, res) => res.json({ googleClientId: googleClientId || null }));

app.post("/api/auth/google", async (req, res) => {
  if (!googleAuthClient) return res.status(503).json({ error: "Not configured" });
  try {
    const ticket = await googleAuthClient.verifyIdToken({ idToken: req.body.credential, audience: googleClientId });
    const p = ticket.getPayload();
    const email = normEmail(p.email || "");
    const name = p.name || email || "User";
    const picture = p.picture || "";
    if (email) database.prepare(`INSERT INTO users (email, name, picture, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET name=excluded.name, picture=excluded.picture, updated_at=CURRENT_TIMESTAMP`).run(email, name, picture);
    res.json({ name, email, picture });
  } catch { res.status(401).json({ error: "Verification failed" }); }
});

app.get("/api/users", (req, res) => {
  const u = database.prepare("SELECT email, name, picture FROM users WHERE email = ?").get(normEmail(req.query.email));
  res.json(u || null);
});

app.get("/api/users/find", (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.json(null);
  const u = database.prepare("SELECT email, name, picture FROM users WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1").get(name);
  res.json(u || null);
});

app.get("/api/users/list", (req, res) => {
  const me = normEmail(req.query.me);
  const q = String(req.query.q || "").trim().toLowerCase();
  let query = "SELECT email, name, picture FROM users WHERE email != ''";
  const params = [];
  if (me) { query += " AND email != ?"; params.push(me); }
  if (q) { query += " AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  query += " ORDER BY updated_at DESC LIMIT 100";
  const users = database.prepare(query).all(...params);
  const enriched = users.map(u => {
    if (!me) return { ...u, status: "none" };
    const pair = me < u.email ? [me, u.email] : [u.email, me];
    if (database.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").get(pair[0], pair[1])) return { ...u, status: "friends" };
    const o = database.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").get(me, u.email);
    if (o) return { ...u, status: "outgoing", requestId: o.id };
    const i = database.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").get(u.email, me);
    if (i) return { ...u, status: "incoming", requestId: i.id };
    return { ...u, status: "none" };
  });
  res.json(enriched);
});

app.get("/api/likes", (req, res) => {
  const { mediaId, visitorId } = req.query;
  const count = database.prepare("SELECT COUNT(*) AS count FROM likes WHERE media_id = ?").get(mediaId).count;
  const liked = !!database.prepare("SELECT 1 FROM likes WHERE media_id = ? AND visitor_id = ?").get(mediaId, visitorId);
  res.json({ mediaId, count, liked });
});
app.post("/api/likes", (req, res) => {
  const { mediaId, visitorId } = req.body;
  if (!mediaId || !visitorId) return res.status(400).json({ error: "Missing data" });
  const existing = !!database.prepare("SELECT 1 FROM likes WHERE media_id = ? AND visitor_id = ?").get(mediaId, visitorId);
  if (existing) database.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").run(mediaId, visitorId);
  else database.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)").run(mediaId, visitorId);
  const count = database.prepare("SELECT COUNT(*) AS count FROM likes WHERE media_id = ?").get(mediaId).count;
  mediaCache.ts = 0;
  res.json({ mediaId, count, liked: !existing });
});

app.post("/api/views", (req, res) => {
  const { mediaId, visitorId } = req.body;
  if (!mediaId || !visitorId) return res.status(400).json({ error: "missing" });
  database.prepare("INSERT OR IGNORE INTO media_views (media_id, visitor_id) VALUES (?, ?)").run(mediaId, visitorId);
  const count = database.prepare("SELECT COUNT(*) AS count FROM media_views WHERE media_id = ?").get(mediaId).count;
  mediaCache.ts = 0;
  res.json({ mediaId, count });
});
app.get("/api/views", (req, res) => {
  const { mediaId } = req.query;
  const count = database.prepare("SELECT COUNT(*) AS count FROM media_views WHERE media_id = ?").get(mediaId).count;
  res.json({ mediaId, count });
});

app.post("/api/watch", (req, res) => {
  const { mediaId, visitorId, seconds, duration, creator, title } = req.body;
  if (!mediaId || !visitorId || !duration) return res.status(400).json({ error: "missing" });
  database.prepare("INSERT INTO watch_events (id, media_id, visitor_id, seconds, duration) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), mediaId, visitorId, Number(seconds) || 0, Number(duration) || 0);
  const tags = new Set();
  if (creator) tags.add(`creator:${String(creator).toLowerCase()}`);
  if (title) String(title).toLowerCase().split(/\W+/).filter(w => w.length >= 4).forEach(w => tags.add(`tag:${w}`));
  for (const tag of tags) {
    database.prepare(`INSERT INTO user_interests (visitor_id, tag, weight, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(visitor_id, tag) DO UPDATE SET weight = weight + 1, updated_at = CURRENT_TIMESTAMP`).run(visitorId, tag);
  }
  mediaCache.ts = 0;
  res.json({ ok: true });
});

async function listMediaWithStats() {
  if (!r2) return [];
  const list = async (prefix) => {
    const listed = await r2.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: `${prefix}/`, MaxKeys: 1000 }));
    return Promise.all((listed.Contents || []).map(async (o) => {
      const stored = await r2.send(new HeadObjectCommand({ Bucket: bucketName, Key: o.Key }));
      const m = stored.Metadata || {};
      return {
        key: o.Key,
        type: m.kind || (prefix === "photos" ? "photo" : "video"),
        title: m.title || o.Key.split("/").pop(),
        creator: m.creator || "Anonymous",
        creatorEmail: m.creatoremail || "",
        creatorPic: m.creatorpic || "",
        uploadedAt: m.uploadedat || o.LastModified?.toISOString(),
        url: `/media/${encodeURIComponent(o.Key)}`
      };
    }));
  };
  const [v, p] = await Promise.all([list("videos"), list("photos")]);
  const all = [...v, ...p];
  const likesMap = Object.fromEntries(database.prepare("SELECT media_id, COUNT(*) as c FROM likes GROUP BY media_id").all().map(r => [r.media_id, r.c]));
  const viewsMap = Object.fromEntries(database.prepare("SELECT media_id, COUNT(*) as c FROM media_views GROUP BY media_id").all().map(r => [r.media_id, r.c]));
  const watchMap = Object.fromEntries(database.prepare("SELECT media_id, AVG(CASE WHEN duration > 0 THEN MIN(seconds * 1.0 / duration, 1.0) ELSE 0 END) as completion FROM watch_events GROUP BY media_id").all().map(r => [r.media_id, r.completion]));

  const usersRows = database.prepare("SELECT email, name FROM users").all();
  const nameToEmail = {};
  usersRows.forEach(u => { if (u.name) nameToEmail[String(u.name).toLowerCase().trim()] = u.email; });

  return all.map(item => {
    let email = item.creatorEmail || "";
    if (!email && item.creator) email = nameToEmail[String(item.creator).toLowerCase().trim()] || "";
    return {
      ...item,
      creatorEmail: email,
      views: viewsMap[item.key] || 0,
      likes: likesMap[item.key] || 0,
      completion: watchMap[item.key] || 0
    };
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function getCachedMedia() {
  const now = Date.now();
  if (mediaCache.data && (now - mediaCache.ts) < MEDIA_CACHE_MS) return mediaCache.data;
  const fresh = await listMediaWithStats();
  mediaCache.data = fresh;
  mediaCache.ts = now;
  return fresh;
}

app.get("/api/media", async (req, res) => {
  if (!r2) return res.status(503).json({ error: "R2 not configured" });
  try { res.json(await getCachedMedia()); }
  catch { res.status(500).json({ error: "Load failed" }); }
});

app.get("/api/recommendations", async (req, res) => {
  if (!r2) return res.status(503).json({ error: "R2 not configured" });
  try {
    const visitorId = String(req.query.visitorId || "");
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const all = (await getCachedMedia()).filter(m => m.type === "video");
    const maxLikes = Math.max(1, ...all.map(v => v.likes));
    const maxViews = Math.max(1, ...all.map(v => v.views));
    let interests = {};
    if (visitorId) database.prepare("SELECT tag, weight FROM user_interests WHERE visitor_id = ?").all(visitorId).forEach(r => interests[r.tag] = r.weight);
    const maxInterest = Math.max(1, ...Object.values(interests));
    const scored = all.map(item => {
      const perf = 0.4 * (item.views / maxViews) + 0.3 * (item.likes / maxLikes) + 0.3 * (item.completion || 0);
      let interestScore = 0;
      interestScore += (interests[`creator:${(item.creator || "").toLowerCase()}`] || 0) / maxInterest;
      String(item.title || "").toLowerCase().split(/\W+/).filter(w => w.length >= 4).forEach(t => { interestScore += (interests[`tag:${t}`] || 0) / maxInterest; });
      interestScore = Math.min(1, interestScore / 3);
      const ageDays = (Date.now() - new Date(item.uploadedAt || 0).getTime()) / 86400000;
      const recencyBoost = Math.max(0, 0.2 * (1 - ageDays / 30));
      return { ...item, _score: 0.6 * perf + 0.4 * interestScore + recencyBoost };
    });
    scored.sort((a, b) => b._score - a._score);
    res.json(scored.slice(0, limit).map(({ _score, ...rest }) => rest));
  } catch { res.status(500).json({ error: "failed" }); }
});

app.get("/api/friends/status", (req, res) => {
  const me = normEmail(req.query.me), target = normEmail(req.query.target);
  if (!me || !target) return res.json({ status: "none" });
  const pair = me < target ? [me, target] : [target, me];
  if (database.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").get(pair[0], pair[1])) return res.json({ status: "friends" });
  const o = database.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").get(me, target);
  if (o) return res.json({ status: "outgoing", requestId: o.id });
  const i = database.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").get(target, me);
  if (i) return res.json({ status: "incoming", requestId: i.id });
  res.json({ status: "none" });
});
app.post("/api/friends/request", (req, res) => {
  const from = normEmail(req.body.from), to = normEmail(req.body.to);
  if (!from || !to || from === to) return res.status(400).json({ error: "invalid" });
  const pair = from < to ? [from, to] : [to, from];
  if (database.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").get(pair[0], pair[1])) return res.status(400).json({ error: "Already friends" });
  try {
    const id = randomUUID();
    database.prepare("INSERT INTO friend_requests (id, from_email, to_email, status) VALUES (?, ?, ?, 'pending')").run(id, from, to);
    res.json({ ok: true, id });
  } catch {
    const existing = database.prepare("SELECT id, status FROM friend_requests WHERE from_email = ? AND to_email = ?").get(from, to);
    if (existing && existing.status === "rejected") {
      database.prepare("UPDATE friend_requests SET status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
      return res.json({ ok: true, id: existing.id, revived: true });
    }
    if (existing && existing.status === "pending") return res.json({ ok: true, id: existing.id, alreadyPending: true });
    res.status(400).json({ error: "Request already exists" });
  }
});
app.post("/api/friends/accept", (req, res) => {
  const me = normEmail(req.body.me);
  const reqRow = database.prepare("SELECT * FROM friend_requests WHERE id = ? AND to_email = ? AND status = 'pending'").get(req.body.requestId, me);
  if (!reqRow) return res.status(404).json({ error: "Not found" });
  database.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(reqRow.id);
  const pair = reqRow.from_email < reqRow.to_email ? [reqRow.from_email, reqRow.to_email] : [reqRow.to_email, reqRow.from_email];
  database.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b) VALUES (?, ?)").run(pair[0], pair[1]);
  res.json({ ok: true });
});
app.post("/api/friends/reject", (req, res) => {
  database.prepare("UPDATE friend_requests SET status = 'rejected' WHERE id = ? AND to_email = ?").run(req.body.requestId, normEmail(req.body.me));
  res.json({ ok: true });
});
app.get("/api/friends/list", (req, res) => {
  const me = normEmail(req.query.me);
  if (!me) return res.json([]);
  const rows = database.prepare("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as friend_email FROM friendships WHERE user_a = ? OR user_b = ?").all(me, me, me);
  const emails = rows.map(r => r.friend_email);
  if (!emails.length) return res.json([]);
  const ph = emails.map(() => "?").join(",");
  const users = database.prepare(`SELECT email, name, picture FROM users WHERE email IN (${ph})`).all(...emails);
  const uMap = Object.fromEntries(users.map(u => [u.email, u]));
  const out = emails.map(email => {
    const last = database.prepare(`SELECT body, created_at FROM messages WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?) ORDER BY created_at DESC LIMIT 1`).get(me, email, email, me);
    return { email, name: uMap[email]?.name || email, picture: uMap[email]?.picture || "", lastMessage: last?.body || "", lastAt: last?.created_at || null };
  });
  res.json(out);
});
app.get("/api/friends/pending", (req, res) => {
  const me = normEmail(req.query.me);
  if (!me) return res.json({ incoming: [], outgoing: [] });
  const inc = database.prepare(`SELECT fr.id, fr.from_email as email, u.name, u.picture FROM friend_requests fr LEFT JOIN users u ON u.email = fr.from_email WHERE fr.to_email = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`).all(me);
  const out = database.prepare(`SELECT fr.id, fr.to_email as email, u.name, u.picture FROM friend_requests fr LEFT JOIN users u ON u.email = fr.to_email WHERE fr.from_email = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`).all(me);
  res.json({ incoming: inc, outgoing: out });
});

// ⭐ Messages — non-friends bhi
app.get("/api/messages", (req, res) => {
  const me = normEmail(req.query.me), withEmail = normEmail(req.query.with);
  if (!me || !withEmail) return res.json([]);
  const rows = database.prepare(
    `SELECT id, from_email as sender, to_email as recipient, body, created_at, read_at
     FROM messages
     WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)
     ORDER BY created_at ASC LIMIT 500`
  ).all(me, withEmail, withEmail, me);
  database.prepare("UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE from_email = ? AND to_email = ? AND read_at IS NULL").run(withEmail, me);
  res.json(rows);
});
app.post("/api/messages", (req, res) => {
  const from = normEmail(req.body.from), to = normEmail(req.body.to);
  const body = String(req.body.body || "").trim().slice(0, 2000);
  if (!from || !to || !body) return res.status(400).json({ error: "missing" });
  if (from === to) return res.status(400).json({ error: "Cannot message yourself" });
  const id = randomUUID();
  database.prepare("INSERT INTO messages (id, from_email, to_email, body) VALUES (?, ?, ?, ?)").run(id, from, to, body);
  res.json({ ok: true, id });
});

app.get("/api/conversations", (req, res) => {
  const me = normEmail(req.query.me);
  if (!me) return res.json([]);
  const rows = database.prepare(
    `SELECT
       CASE WHEN from_email = ? THEN to_email ELSE from_email END AS peer_email,
       MAX(created_at) AS last_at,
       SUM(CASE WHEN to_email = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
     FROM messages
     WHERE from_email = ? OR to_email = ?
     GROUP BY peer_email
     ORDER BY last_at DESC
     LIMIT 100`
  ).all(me, me, me, me);
  const peers = rows.map(r => r.peer_email);
  if (!peers.length) return res.json([]);
  const ph = peers.map(() => "?").join(",");
  const users = database.prepare(`SELECT email, name, picture FROM users WHERE email IN (${ph})`).all(...peers);
  const uMap = Object.fromEntries(users.map(u => [u.email, u]));
  const out = rows.map(r => {
    const last = database.prepare(
      `SELECT body, created_at, from_email FROM messages
       WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)
       ORDER BY created_at DESC LIMIT 1`
    ).get(me, r.peer_email, r.peer_email, me);
    return {
      email: r.peer_email,
      name: uMap[r.peer_email]?.name || r.peer_email,
      picture: uMap[r.peer_email]?.picture || "",
      lastMessage: last?.body || "",
      lastAt: last?.created_at || r.last_at,
      lastFromMe: last?.from_email === me,
      unread: r.unread || 0
    };
  });
  res.json(out);
});

app.post("/api/upload", upload.fields([{ name: "media", maxCount: 1 }, { name: "video", maxCount: 1 }]), async (req, res) => {
  if (!r2) return res.status(503).json({ error: "R2 not configured" });
  try {
    const file = req.files?.media?.[0] || req.files?.video?.[0];
    if (!file) return res.status(400).json({ error: "No file" });
    const isPhoto = file.mimetype.startsWith("image/");
    const key = `${isPhoto ? "photos" : "videos"}/${Date.now()}-${randomUUID()}.${extensionFor(file.mimetype, file.originalname)}`;
    const title = safeText(req.body.title, file.originalname, 120);
    const creator = safeText(req.body.creator, "Anonymous", 80);
    const creatorEmail = normEmail(req.body.creatorEmail);
    const creatorPic = safeText(req.body.creatorPic, "", 500);
    const uploadedAt = new Date().toISOString();
    await r2.send(new PutObjectCommand({
      Bucket: bucketName, Key: key, Body: file.buffer, ContentType: file.mimetype,
      Metadata: { kind: isPhoto ? "photo" : "video", title, creator, creatoremail: creatorEmail, creatorpic: creatorPic, uploadedat: uploadedAt }
    }));
    mediaCache.ts = 0;
    res.status(201).json({ key, type: isPhoto ? "photo" : "video", title, creator, creatorEmail, creatorPic, uploadedAt, url: `/media/${encodeURIComponent(key)}` });
  } catch { res.status(500).json({ error: "Upload failed" }); }
});

app.get("/media/:encodedKey", async (req, res) => {
  if (!r2) return res.status(503).send("R2 not configured");
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: bucketName, Key: decodeURIComponent(req.params.encodedKey) }));
    res.setHeader("Cache-Control", "public, max-age=31536000");
    if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
    object.Body.pipe(res);
  } catch { res.status(404).send("Not found"); }
});

app.listen(port, () => console.log(`Running on ${port}`));
