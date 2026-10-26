const MAX_FILE_SIZE = 90 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/gif","image/avif",
  "video/mp4","video/quicktime","video/webm","video/ogg","video/x-matroska"
]);

const mediaCache = { data: null, ts: 0 };
const MEDIA_CACHE_MS = 30 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS likes (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id))`,
  `CREATE INDEX IF NOT EXISTS likes_media_id_idx ON likes (media_id)`,
  `CREATE TABLE IF NOT EXISTS media_views (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id))`,
  `CREATE INDEX IF NOT EXISTS media_views_media_id_idx ON media_views (media_id)`,
  `CREATE TABLE IF NOT EXISTS watch_events (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS watch_events_media_id_idx ON watch_events (media_id)`,
  `CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, from_email TEXT NOT NULL, to_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(from_email, to_email))`,
  `CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_email, status)`,
  `CREATE INDEX IF NOT EXISTS friend_requests_from_idx ON friend_requests (from_email, status)`,
  `CREATE TABLE IF NOT EXISTS friendships (user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_a, user_b))`,
  `CREATE INDEX IF NOT EXISTS friendships_a_idx ON friendships (user_a)`,
  `CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships (user_b)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_email TEXT NOT NULL, to_email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages (from_email, to_email, created_at)`,
  `CREATE TABLE IF NOT EXISTS user_interests (visitor_id TEXT NOT NULL, tag TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (visitor_id, tag))`,
  `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, picture TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA) {
    try { await env.DB.prepare(sql).run(); } catch (e) { console.error("Schema:", e.message); }
  }
  schemaReady = true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}
function safeText(v, f, m) { const t = String(v || "").trim().slice(0, m); return t || f; }
function extensionFor(type, name) {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "video/quicktime") return "mov";
  return type.split("/")[1];
}
function mediaUrl(key) { return `/media/${encodeURIComponent(key)}`; }

async function verifyGoogleToken(token, googleClientId) {
  if (!token || !googleClientId) return null;
  try {
    const q = new URLSearchParams({ id_token: token });
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?${q}`);
    if (!r.ok) return null;
    const p = await r.json();
    if (p.aud !== googleClientId || p.email_verified !== "true" || !p.sub) return null;
    return p;
  } catch { return null; }
}

async function listMedia(env, prefix) {
  const results = [];
  let cursor;
  do {
    const listed = await env.VIDEOS.list({ prefix: `${prefix}/`, limit: 1000, cursor });
    const heads = await Promise.all(listed.objects.map(async (object) => {
      try {
        const stored = await env.VIDEOS.head(object.key);
        return { object, stored };
      } catch { return { object, stored: null }; }
    }));
    for (const { object, stored } of heads) {
      const m = stored?.customMetadata || {};
      results.push({
        key: object.key,
        type: m.kind || (prefix === "photos" ? "photo" : "video"),
        title: m.title || object.key.split("/").pop(),
        creator: m.creator || "Anonymous creator",
        creatorEmail: m.creatorEmail || m.creatoremail || "",
        creatorPic: m.creatorPic || m.creatorpic || "",
        uploadedAt: m.uploadedAt || m.uploadedat || object.uploaded.toISOString(),
        url: mediaUrl(object.key)
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return results;
}

async function listMediaWithStats(env) {
  const [videos, photos] = await Promise.all([listMedia(env, "videos"), listMedia(env, "photos")]);
  const all = [...videos, ...photos];
  const [likeRows, viewRows, watchRows] = await Promise.all([
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM likes GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM media_views GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, AVG(CASE WHEN duration > 0 THEN MIN(seconds * 1.0 / duration, 1.0) ELSE 0 END) as completion FROM watch_events GROUP BY media_id").all()
  ]);
  const likesMap = Object.fromEntries((likeRows.results || []).map(r => [r.media_id, r.c]));
  const viewsMap = Object.fromEntries((viewRows.results || []).map(r => [r.media_id, r.c]));
  const watchMap = Object.fromEntries((watchRows.results || []).map(r => [r.media_id, r.completion]));

  const usersRows = await env.DB.prepare("SELECT email, name FROM users").all();
  const nameToEmail = {};
  (usersRows.results || []).forEach(u => {
    if (u.name) nameToEmail[String(u.name).toLowerCase().trim()] = u.email;
  });

  return all.map(item => {
    let email = item.creatorEmail || "";
    if (!email && item.creator) {
      email = nameToEmail[String(item.creator).toLowerCase().trim()] || "";
    }
    return {
      ...item,
      creatorEmail: email,
      views: viewsMap[item.key] || 0,
      likes: likesMap[item.key] || 0,
      completion: watchMap[item.key] || 0
    };
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function getCachedMedia(env) {
  const now = Date.now();
  if (mediaCache.data && (now - mediaCache.ts) < MEDIA_CACHE_MS) return mediaCache.data;
  const fresh = await listMediaWithStats(env);
  mediaCache.data = fresh;
  mediaCache.ts = now;
  return fresh;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization"
      }});
    }

    if (path.startsWith("/api/")) await ensureSchema(env);

    if (path === "/api/auth/config" && method === "GET") {
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    }

    if (path === "/api/auth/google" && method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: "Not configured" }, 503);
      try {
        const body = await request.json();
        const user = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: "Verification failed" }, 401);
        const email = (user.email || "").toLowerCase();
        const name = user.name || email || "User";
        const picture = user.picture || "";
        if (email) {
          await env.DB.prepare(`INSERT INTO users (email, name, picture, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET name = excluded.name, picture = excluded.picture, updated_at = CURRENT_TIMESTAMP`).bind(email, name, picture).run();
        }
        return json({ name, email, picture });
      } catch { return json({ error: "Invalid request" }, 400); }
    }

    if (path === "/api/users" && method === "GET") {
      const email = (url.searchParams.get("email") || "").toLowerCase();
      if (!email) return json({ error: "missing email" }, 400);
      const u = await env.DB.prepare("SELECT email, name, picture FROM users WHERE email = ?").bind(email).first();
      return json(u || null);
    }

    if (path === "/api/users/find" && method === "GET") {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name) return json(null);
      const u = await env.DB.prepare(
        "SELECT email, name, picture FROM users WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1"
      ).bind(name).first();
      return json(u || null);
    }

    if (path === "/api/users/list" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      let query = "SELECT email, name, picture FROM users WHERE email != ''";
      const params = [];
      if (me) { query += " AND email != ?"; params.push(me); }
      if (q) { query += " AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
      query += " ORDER BY updated_at DESC LIMIT 100";
      const rows = await env.DB.prepare(query).bind(...params).all();
      const users = rows.results || [];
      const enriched = await Promise.all(users.map(async (u) => {
        if (!me) return { ...u, status: "none" };
        const pair = me < u.email ? [me, u.email] : [u.email, me];
        const friend = await env.DB.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").bind(pair[0], pair[1]).first();
        if (friend) return { ...u, status: "friends" };
        const outgoing = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(me, u.email).first();
        if (outgoing) return { ...u, status: "outgoing", requestId: outgoing.id };
        const incoming = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(u.email, me).first();
        if (incoming) return { ...u, status: "incoming", requestId: incoming.id };
        return { ...u, status: "none" };
      }));
      return json(enriched);
    }

    if (path === "/api/likes" && method === "GET") {
      const mediaId = url.searchParams.get("mediaId");
      const visitorId = url.searchParams.get("visitorId");
      const countResult = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
      const userLiked = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
      return json({ mediaId, count: countResult ? countResult.count : 0, liked: !!userLiked });
    }
    if (path === "/api/likes" && method === "POST") {
      try {
        const { mediaId, visitorId } = await request.json();
        if (!mediaId || !visitorId) return json({ error: "Missing data" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
        if (existing) await env.DB.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).run();
        else await env.DB.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)").bind(mediaId, visitorId).run();
        const c = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
        mediaCache.ts = 0;
        return json({ mediaId, count: c ? c.count : 0, liked: !existing });
      } catch (err) { return json({ error: "Database error", details: err.message }, 500); }
    }

    if (path === "/api/views" && method === "POST") {
      try {
        const { mediaId, visitorId } = await request.json();
        if (!mediaId || !visitorId) return json({ error: "missing" }, 400);
        await env.DB.prepare("INSERT OR IGNORE INTO media_views (media_id, visitor_id) VALUES (?, ?)").bind(mediaId, visitorId).run();
        const c = await env.DB.prepare("SELECT COUNT(*) as count FROM media_views WHERE media_id = ?").bind(mediaId).first();
        mediaCache.ts = 0;
        return json({ mediaId, count: c ? c.count : 0 });
      } catch { return json({ error: "failed" }, 500); }
    }
    if (path === "/api/views" && method === "GET") {
      const mediaId = url.searchParams.get("mediaId");
      const c = await env.DB.prepare("SELECT COUNT(*) as count FROM media_views WHERE media_id = ?").bind(mediaId).first();
      return json({ mediaId, count: c ? c.count : 0 });
    }

    if (path === "/api/watch" && method === "POST") {
      try {
        const b = await request.json();
        const { mediaId, visitorId, seconds, duration, creator, title } = b;
        if (!mediaId || !visitorId || !duration) return json({ error: "missing" }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO watch_events (id, media_id, visitor_id, seconds, duration) VALUES (?, ?, ?, ?, ?)")
          .bind(id, mediaId, visitorId, Number(seconds) || 0, Number(duration) || 0).run();
        const tags = new Set();
        if (creator) tags.add(`creator:${String(creator).toLowerCase()}`);
        if (title) String(title).toLowerCase().split(/\W+/).filter(w => w.length >= 4).forEach(w => tags.add(`tag:${w}`));
        for (const tag of tags) {
          await env.DB.prepare(`INSERT INTO user_interests (visitor_id, tag, weight, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(visitor_id, tag) DO UPDATE SET weight = weight + 1, updated_at = CURRENT_TIMESTAMP`).bind(visitorId, tag).run();
        }
        mediaCache.ts = 0;
        return json({ ok: true });
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/recommendations" && method === "GET") {
      try {
        const visitorId = url.searchParams.get("visitorId") || "";
        const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 100);
        const all = await getCachedMedia(env);
        const videos = all.filter(m => m.type === "video");
        const maxLikes = Math.max(1, ...videos.map(v => v.likes));
        const maxViews = Math.max(1, ...videos.map(v => v.views));
        let interests = {};
        if (visitorId) {
          const rows = await env.DB.prepare("SELECT tag, weight FROM user_interests WHERE visitor_id = ?").bind(visitorId).all();
          (rows.results || []).forEach(r => interests[r.tag] = r.weight);
        }
        const maxInterest = Math.max(1, ...Object.values(interests));
        const scored = videos.map(item => {
          const perf = 0.4 * (item.views / maxViews) + 0.3 * (item.likes / maxLikes) + 0.3 * (item.completion || 0);
          let interestScore = 0;
          const cTag = `creator:${(item.creator || "").toLowerCase()}`;
          interestScore += (interests[cTag] || 0) / maxInterest;
          String(item.title || "").toLowerCase().split(/\W+/).filter(w => w.length >= 4).forEach(t => { interestScore += (interests[`tag:${t}`] || 0) / maxInterest; });
          interestScore = Math.min(1, interestScore / 3);
          const ageDays = (Date.now() - new Date(item.uploadedAt || 0).getTime()) / 86400000;
          const recencyBoost = Math.max(0, 0.2 * (1 - ageDays / 30));
          return { ...item, _score: 0.6 * perf + 0.4 * interestScore + recencyBoost };
        });
        scored.sort((a, b) => b._score - a._score);
        return json(scored.slice(0, limit).map(({ _score, ...rest }) => rest));
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/friends/status" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      const target = (url.searchParams.get("target") || "").toLowerCase();
      if (!me || !target) return json({ status: "none" });
      const pair = me < target ? [me, target] : [target, me];
      const friend = await env.DB.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").bind(pair[0], pair[1]).first();
      if (friend) return json({ status: "friends" });
      const outgoing = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(me, target).first();
      if (outgoing) return json({ status: "outgoing", requestId: outgoing.id });
      const incoming = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(target, me).first();
      if (incoming) return json({ status: "incoming", requestId: incoming.id });
      return json({ status: "none" });
    }
    if (path === "/api/friends/request" && method === "POST") {
      const b = await request.json();
      const from = (b.from || "").toLowerCase(), to = (b.to || "").toLowerCase();
      if (!from || !to || from === to) return json({ error: "invalid" }, 400);
      const pair = from < to ? [from, to] : [to, from];
      const exists = await env.DB.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").bind(pair[0], pair[1]).first();
      if (exists) return json({ error: "Already friends" }, 400);
      try {
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO friend_requests (id, from_email, to_email, status) VALUES (?, ?, ?, 'pending')").bind(id, from, to).run();
        return json({ ok: true, id });
      } catch {
        const existing = await env.DB.prepare("SELECT id, status FROM friend_requests WHERE from_email = ? AND to_email = ?").bind(from, to).first();
        if (existing && existing.status === "rejected") {
          await env.DB.prepare("UPDATE friend_requests SET status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.id).run();
          return json({ ok: true, id: existing.id, revived: true });
        }
        if (existing && existing.status === "pending") return json({ ok: true, id: existing.id, alreadyPending: true });
        return json({ error: "Request already exists" }, 400);
      }
    }
    if (path === "/api/friends/accept" && method === "POST") {
      const b = await request.json();
      const me = (b.me || "").toLowerCase();
      const req = await env.DB.prepare("SELECT * FROM friend_requests WHERE id = ? AND to_email = ? AND status = 'pending'").bind(b.requestId, me).first();
      if (!req) return json({ error: "Not found" }, 404);
      await env.DB.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").bind(b.requestId).run();
      const pair = req.from_email < req.to_email ? [req.from_email, req.to_email] : [req.to_email, req.from_email];
      await env.DB.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b) VALUES (?, ?)").bind(pair[0], pair[1]).run();
      return json({ ok: true });
    }
    if (path === "/api/friends/reject" && method === "POST") {
      const b = await request.json();
      await env.DB.prepare("UPDATE friend_requests SET status = 'rejected' WHERE id = ? AND to_email = ?").bind(b.requestId, (b.me || "").toLowerCase()).run();
      return json({ ok: true });
    }
    if (path === "/api/friends/list" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json([]);
      const rows = await env.DB.prepare("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as friend_email FROM friendships WHERE user_a = ? OR user_b = ?").bind(me, me, me).all();
      const emails = (rows.results || []).map(r => r.friend_email);
      if (!emails.length) return json([]);
      const ph = emails.map(() => "?").join(",");
      const users = await env.DB.prepare(`SELECT email, name, picture FROM users WHERE email IN (${ph})`).bind(...emails).all();
      const uMap = Object.fromEntries((users.results || []).map(u => [u.email, u]));
      const out = await Promise.all(emails.map(async (email) => {
        const last = await env.DB.prepare(`SELECT body, created_at FROM messages WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?) ORDER BY created_at DESC LIMIT 1`).bind(me, email, email, me).first();
        return { email, name: uMap[email]?.name || email, picture: uMap[email]?.picture || "", lastMessage: last?.body || "", lastAt: last?.created_at || null };
      }));
      return json(out);
    }
    if (path === "/api/friends/pending" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json({ incoming: [], outgoing: [] });
      const inc = await env.DB.prepare(`SELECT fr.id, fr.from_email as email, u.name, u.picture FROM friend_requests fr LEFT JOIN users u ON u.email = fr.from_email WHERE fr.to_email = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`).bind(me).all();
      const out = await env.DB.prepare(`SELECT fr.id, fr.to_email as email, u.name, u.picture FROM friend_requests fr LEFT JOIN users u ON u.email = fr.to_email WHERE fr.from_email = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`).bind(me).all();
      return json({ incoming: inc.results || [], outgoing: out.results || [] });
    }

    // ⭐ Messages: non-friends bhi message kar sakte hain
    if (path === "/api/messages" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      const withEmail = (url.searchParams.get("with") || "").toLowerCase();
      if (!me || !withEmail) return json([]);
      const rows = await env.DB.prepare(
        `SELECT id, from_email as sender, to_email as recipient, body, created_at, read_at
         FROM messages
         WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)
         ORDER BY created_at ASC LIMIT 500`
      ).bind(me, withEmail, withEmail, me).all();
      // Mark incoming as read
      await env.DB.prepare(
        "UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE from_email = ? AND to_email = ? AND read_at IS NULL"
      ).bind(withEmail, me).run();
      return json(rows.results || []);
    }
    if (path === "/api/messages" && method === "POST") {
      const b = await request.json();
      const from = (b.from || "").toLowerCase(), to = (b.to || "").toLowerCase();
      const body = String(b.body || "").trim().slice(0, 2000);
      if (!from || !to || !body) return json({ error: "missing" }, 400);
      if (from === to) return json({ error: "Cannot message yourself" }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO messages (id, from_email, to_email, body) VALUES (?, ?, ?, ?)").bind(id, from, to, body).run();
      return json({ ok: true, id });
    }

    // ⭐ Conversations list (chats with last message + unread)
    if (path === "/api/conversations" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json([]);
      const rows = await env.DB.prepare(
        `SELECT
           CASE WHEN from_email = ? THEN to_email ELSE from_email END AS peer_email,
           MAX(created_at) AS last_at,
           SUM(CASE WHEN to_email = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM messages
         WHERE from_email = ? OR to_email = ?
         GROUP BY peer_email
         ORDER BY last_at DESC
         LIMIT 100`
      ).bind(me, me, me, me).all();
      const peers = (rows.results || []).map(r => r.peer_email);
      if (!peers.length) return json([]);
      const ph = peers.map(() => "?").join(",");
      const users = await env.DB.prepare(`SELECT email, name, picture FROM users WHERE email IN (${ph})`).bind(...peers).all();
      const uMap = Object.fromEntries((users.results || []).map(u => [u.email, u]));
      const out = await Promise.all((rows.results || []).map(async (r) => {
        const last = await env.DB.prepare(
          `SELECT body, created_at, from_email FROM messages
           WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)
           ORDER BY created_at DESC LIMIT 1`
        ).bind(me, r.peer_email, r.peer_email, me).first();
        return {
          email: r.peer_email,
          name: uMap[r.peer_email]?.name || r.peer_email,
          picture: uMap[r.peer_email]?.picture || "",
          lastMessage: last?.body || "",
          lastAt: last?.created_at || r.last_at,
          lastFromMe: last?.from_email === me,
          unread: r.unread || 0
        };
      }));
      return json(out);
    }

    if (path === "/api/upload" && method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: "Not configured" }, 503);
      const authz = request.headers.get("authorization") || "";
      const m = authz.match(/^Bearer\s+(.+)$/i);
      const gUser = m ? await verifyGoogleToken(m[1], env.GOOGLE_CLIENT_ID) : null;
      if (!gUser) return json({ error: "Sign in first" }, 401);
      try {
        const form = await request.formData();
        const file = form.get("media") || form.get("video");
        if (!(file instanceof File)) return json({ error: "Choose a file" }, 400);
        if (!ALLOWED_TYPES.has(file.type)) return json({ error: "Format not supported" }, 415);
        if (file.size > MAX_FILE_SIZE) return json({ error: "File too large" }, 413);
        const isPhoto = file.type.startsWith("image/");
        const type = isPhoto ? "photo" : "video";
        const folder = isPhoto ? "photos" : "videos";
        const id = `${Date.now()}-${crypto.randomUUID()}`;
        const key = `${folder}/${id}.${extensionFor(file.type, file.name)}`;
        const title = safeText(form.get("title"), file.name, 120);
        const creator = safeText(form.get("creator"), "Anonymous", 80);
        const creatorEmail = (form.get("creatorEmail") || "").toLowerCase();
        const creatorPic = safeText(form.get("creatorPic"), "", 500);
        const uploadedAt = new Date().toISOString();
        await env.VIDEOS.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { kind: type, title, creator, creatoremail: creatorEmail, creatorpic: creatorPic, uploadedat: uploadedAt }
        });
        mediaCache.ts = 0;
        return json({ key, type, title, creator, creatorEmail, creatorPic, uploadedAt, url: mediaUrl(key) }, 201);
      } catch { return json({ error: "Upload failed" }, 500); }
    }

    if (path === "/api/media" && method === "GET") {
      try { return json(await getCachedMedia(env)); }
      catch { return json({ error: "Could not load media" }, 500); }
    }

    if (path.startsWith("/media/") && method === "GET") {
      let key;
      try { key = decodeURIComponent(path.slice("/media/".length)); } catch { return new Response("Not found", { status: 404 }); }
      if (!key.startsWith("videos/") && !key.startsWith("photos/")) return new Response("Not found", { status: 404 });
      const object = await env.VIDEOS.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      headers.set("access-control-allow-origin", "*");
      return new Response(object.body, { headers });
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};
