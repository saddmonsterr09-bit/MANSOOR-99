const MAX_FILE_SIZE = 90 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/gif","image/avif",
  "video/mp4","video/quicktime","video/webm","video/ogg","video/x-matroska"
]);

const mediaCache = { data: null, ts: 0 };
const MEDIA_CACHE_MS = 30 * 1000;
const ADMIN_EMAIL = "saddmonsterr09@gmail.com"; 

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
  `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, picture TEXT, bio TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, author_email TEXT, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS comments_media_idx ON comments (media_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS copyright_reports (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, media_url TEXT NOT NULL, reporter_email TEXT, reporter_name TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS blocked_users (user_email TEXT NOT NULL, blocked_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_email, blocked_email))`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA) {
    try { await env.DB.prepare(sql).run(); } catch (e) { console.error("Schema:", e.message); }
  }
  // Safely add bio column if it doesn't exist
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN bio TEXT").run(); } catch (e) {}
  schemaReady = true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", "access-control-allow-origin": "*", "cache-control": "no-store" }
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

async function listMediaWithStats(env, viewerId) {
  const [videos, photos] = await Promise.all([listMedia(env, "videos"), listMedia(env, "photos")]);
  let all = [...videos, ...photos];
  
  const [likeRows, viewRows, watchRows, commentRows, usersRows] = await Promise.all([
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM likes GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM media_views GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, AVG(CASE WHEN duration > 0 THEN MIN(seconds * 1.0 / duration, 1.0) ELSE 0 END) as completion FROM watch_events GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM comments GROUP BY media_id").all(),
    env.DB.prepare("SELECT email, name, picture FROM users").all()
  ]);

  const likesMap = Object.fromEntries((likeRows.results || []).map(r => [r.media_id, r.c]));
  const viewsMap = Object.fromEntries((viewRows.results || []).map(r => [r.media_id, r.c]));
  const watchMap = Object.fromEntries((watchRows.results || []).map(r => [r.media_id, r.completion]));
  const commentsMap = Object.fromEntries((commentRows.results || []).map(r => [r.media_id, r.c]));
  
  const emailToUser = {};
  (usersRows.results || []).forEach(u => { emailToUser[u.email.toLowerCase()] = u; });

  let blockedList = [];
  if (viewerId) {
    const bRows = await env.DB.prepare("SELECT blocked_email FROM blocked_users WHERE user_email = ?").bind(viewerId.toLowerCase()).all();
    blockedList = (bRows.results || []).map(r => r.blocked_email.toLowerCase());
  }

  return all.filter(item => {
    let email = item.creatorEmail || "";
    return !blockedList.includes(email.toLowerCase());
  }).map(item => {
    let email = item.creatorEmail || "";
    let latestUser = email ? emailToUser[email.toLowerCase()] : null;
    
    return {
      ...item,
      creator: latestUser ? (latestUser.name || item.creator) : item.creator,
      creatorPic: latestUser ? (latestUser.picture || item.creatorPic) : item.creatorPic,
      creatorEmail: email,
      views: viewsMap[item.key] || 0,
      likes: likesMap[item.key] || 0,
      comments: commentsMap[item.key] || 0,
      completion: watchMap[item.key] || 0
    };
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function getCachedMedia(env, viewerId) {
  const now = Date.now();
  const cacheKey = viewerId ? `media_${viewerId}` : 'media_public';
  if (mediaCache[cacheKey] && (now - mediaCache.ts) < MEDIA_CACHE_MS) return mediaCache[cacheKey];
  const fresh = await listMediaWithStats(env, viewerId);
  mediaCache[cacheKey] = fresh;
  mediaCache.ts = now;
  return fresh;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" }});
    }

    if (path.startsWith("/api/")) await ensureSchema(env);

    if (path === "/api/auth/config" && method === "GET") return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });

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
          const existing = await env.DB.prepare("SELECT bio FROM users WHERE email = ?").bind(email).first();
          if (existing) {
             await env.DB.prepare(`UPDATE users SET name = ?, picture = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).bind(name, picture, email).run();
             return json({ name, email, picture, bio: existing.bio || "" });
          } else {
             await env.DB.prepare(`INSERT INTO users (email, name, picture, bio, updated_at) VALUES (?, ?, ?, '', CURRENT_TIMESTAMP)`).bind(email, name, picture).run();
             return json({ name, email, picture, bio: "" });
          }
        }
        return json({ error: "No email" }, 400);
      } catch { return json({ error: "Invalid request" }, 400); }
    }

    // ⭐ UPDATE PROFILE (Name, Pic, Bio)
    if (path === "/api/user/update" && method === "POST") {
      try {
        const { email, name, picture, bio } = await request.json();
        if (!email) return json({ error: "Missing email" }, 400);
        await env.DB.prepare(`UPDATE users SET name = ?, picture = ?, bio = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).bind(name, picture, bio, email.toLowerCase()).run();
        mediaCache.ts = 0; // Clear cache to show new name/pic on old videos
        return json({ ok: true, name, picture, bio });
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/users/find" && method === "GET") {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name) return json(null);
      const u = await env.DB.prepare("SELECT email, name, picture, bio FROM users WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1").bind(name).first();
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
        if (await env.DB.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").bind(pair[0], pair[1]).first()) return { ...u, status: "friends" };
        const o = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(me, u.email).first();
        if (o) return { ...u, status: "outgoing", requestId: o.id };
        const i = await env.DB.prepare("SELECT id FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'").bind(u.email, me).first();
        if (i) return { ...u, status: "incoming", requestId: i.id };
        return { ...u, status: "none" };
      }));
      return json(enriched);
    }

    if (path === "/api/likes" && method === "GET") { /* ... same ... */ 
      const mediaId = url.searchParams.get("mediaId");
      const visitorId = url.searchParams.get("visitorId");
      const countResult = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
      const userLiked = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
      return json({ mediaId, count: countResult ? countResult.count : 0, liked: !!userLiked });
    }
    if (path === "/api/likes" && method === "POST") { /* ... same ... */ 
      try {
        const { mediaId, visitorId } = await request.json();
        if (!mediaId || !visitorId) return json({ error: "Missing data" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
        if (existing) await env.DB.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).run();
        else await env.DB.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)").bind(mediaId, visitorId).run();
        const c = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
        mediaCache.ts = 0; return json({ mediaId, count: c ? c.count : 0, liked: !existing });
      } catch (err) { return json({ error: "Database error" }, 500); }
    }

    if (path === "/api/comments" && method === "GET") { /* ... same ... */ }
    if (path === "/api/comments" && method === "POST") { /* ... same ... */ }

    if (path === "/api/block" && method === "POST") { /* ... same ... */ }
    if (path === "/api/blocked" && method === "GET") { /* ... same ... */ }
    if (path === "/api/report" && method === "POST") { /* ... same ... */ }

    if (path.startsWith("/api/admin/")) { /* ... same auth check ... */ }
    if (path === "/api/admin/reports" && method === "GET") { /* ... same ... */ }
    if (path === "/api/admin/delete-video" && method === "POST") { /* ... same ... */ }
    if (path === "/api/admin/reject-report" && method === "POST") { /* ... same ... */ }

    if (path === "/api/views" && method === "POST") { /* ... same ... */ }
    if (path === "/api/watch" && method === "POST") { /* ... same ... */ }

    if (path === "/api/recommendations" && method === "GET") {
      try {
        const visitorId = url.searchParams.get("visitorId") || "";
        const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 100);
        const all = await getCachedMedia(env, visitorId);
        const videos = all.filter(m => m.type === "video");
        return json(videos.slice(0, limit)); 
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/friends/status" && method === "GET") { /* ... same ... */ }
    if (path === "/api/friends/request" && method === "POST") { /* ... same ... */ }
    if (path === "/api/friends/accept" && method === "POST") { /* ... same ... */ }
    if (path === "/api/friends/reject" && method === "POST") { /* ... same ... */ }
    if (path === "/api/friends/list" && method === "GET") { /* ... same ... */ }
    if (path === "/api/friends/pending" && method === "GET") { /* ... same ... */ }

    if (path === "/api/messages" && method === "GET") { /* ... same ... */ }
    if (path === "/api/messages" && method === "POST") { /* ... same ... */ }
    if (path === "/api/conversations" && method === "GET") { /* ... same ... */ }

    if (path === "/api/upload" && method === "POST") { /* ... same ... */ }

    if (path === "/api/media" && method === "GET") {
      try { 
        const viewerId = url.searchParams.get("me") || "";
        return json(await getCachedMedia(env, viewerId)); 
      }
      catch { return json({ error: "Could not load media" }, 500); }
    }

    if (path.startsWith("/media/") && method === "GET") { /* ... same ... */ }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};
