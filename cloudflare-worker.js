const MAX_FILE_SIZE = 90 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/gif","image/avif",
  "video/mp4","video/quicktime","video/webm","video/ogg","video/x-matroska"
]);

const mediaCache = { data: null, ts: 0 };
const MEDIA_CACHE_MS = 30 * 1000;
const ADMIN_EMAIL = "saddmonsterr09@gmail.com"; 

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS likes (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, user_email TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id))`,
  `CREATE TABLE IF NOT EXISTS media_views (media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (media_id, visitor_id))`,
  `CREATE TABLE IF NOT EXISTS watch_events (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, visitor_id TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS follows (follower_email TEXT NOT NULL, following_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (follower_email, following_email))`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_email TEXT NOT NULL, to_email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_interests (visitor_id TEXT NOT NULL, tag TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (visitor_id, tag))`,
  `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, picture TEXT, bio TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, author_email TEXT, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS copyright_reports (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, media_url TEXT NOT NULL, reporter_email TEXT, reporter_name TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS blocked_users (user_email TEXT NOT NULL, blocked_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_email, blocked_email))`,
  // ⭐ NEW NOTIFICATIONS TABLE
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, type TEXT NOT NULL, from_email TEXT NOT NULL, from_name TEXT NOT NULL, from_pic TEXT, media_id TEXT, content TEXT, is_read INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA) {
    try { await env.DB.prepare(sql).run(); } catch (e) { console.error("Schema:", e.message); }
  }
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN bio TEXT").run(); } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE likes ADD COLUMN user_email TEXT").run(); } catch (e) {}
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

async function getMediaCreator(env, key) {
  try {
    const stored = await env.VIDEOS.head(key);
    return stored?.customMetadata?.creatoremail || stored?.customMetadata?.creatorEmail || null;
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
  
  const [likeRows, viewRows, commentRows, usersRows] = await Promise.all([
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM likes GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM media_views GROUP BY media_id").all(),
    env.DB.prepare("SELECT media_id, COUNT(*) as c FROM comments GROUP BY media_id").all(),
    env.DB.prepare("SELECT email, name, picture FROM users").all()
  ]);

  const likesMap = Object.fromEntries((likeRows.results || []).map(r => [r.media_id, r.c]));
  const viewsMap = Object.fromEntries((viewRows.results || []).map(r => [r.media_id, r.c]));
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
      comments: commentsMap[item.key] || 0
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
             await env.DB.prepare(`INSERT INTO users (email, name, picture, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`).bind(email, name, picture).run();
             return json({ name, email, picture, bio: "" });
          }
        }
        return json({ error: "No email" }, 400);
      } catch { return json({ error: "Invalid request" }, 400); }
    }

    // ⭐ NEW: GET USER STATS
    if (path === "/api/users/stats" && method === "GET") {
      const email = (url.searchParams.get("email") || "").toLowerCase();
      if (!email) return json({ friends: 0, followers: 0 });
      
      const friendsRow = await env.DB.prepare(`
        SELECT COUNT(*) as c FROM follows f1 
        WHERE f1.follower_email = ? AND f1.following_email IN (
          SELECT follower_email FROM follows WHERE following_email = ?
        )
      `).bind(email, email).first();
      
      const followersRow = await env.DB.prepare("SELECT COUNT(*) as c FROM follows WHERE following_email = ?").bind(email).first();
      
      return json({ friends: friendsRow?.c || 0, followers: followersRow?.c || 0 });
    }

    if (path === "/api/user/update" && method === "POST") {
      try {
        const { email, name, picture, bio } = await request.json();
        if (!email) return json({ error: "Missing email" }, 400);
        await env.DB.prepare(`UPDATE users SET name = ?, picture = ?, bio = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).bind(name, picture, bio, email.toLowerCase()).run();
        mediaCache.ts = 0;
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
        const meFollows = await env.DB.prepare("SELECT 1 FROM follows WHERE follower_email = ? AND following_email = ?").bind(me, u.email).first();
        const targetFollows = await env.DB.prepare("SELECT 1 FROM follows WHERE follower_email = ? AND following_email = ?").bind(u.email, me).first();
        if (meFollows && targetFollows) return { ...u, status: "friends" };
        if (meFollows) return { ...u, status: "following" };
        if (targetFollows) return { ...u, status: "follower" };
        return { ...u, status: "none" };
      }));
      return json(enriched);
    }

    // FOLLOW SYSTEM ROUTES
    if (path === "/api/follow" && method === "POST") {
      try {
        const { me, target } = await request.json();
        if (!me || !target) return json({ error: "missing" }, 400);
        const m = me.toLowerCase(), t = target.toLowerCase();
        const existing = await env.DB.prepare("SELECT 1 FROM follows WHERE follower_email = ? AND following_email = ?").bind(m, t).first();
        if (existing) {
          await env.DB.prepare("DELETE FROM follows WHERE follower_email = ? AND following_email = ?").bind(m, t).run();
          return json({ ok: true, action: "unfollowed" });
        } else {
          await env.DB.prepare("INSERT INTO follows (follower_email, following_email) VALUES (?, ?)").bind(m, t).run();
          
          // ⭐ INSERT NOTIFICATION
          try {
            const u = await env.DB.prepare("SELECT name, picture FROM users WHERE email = ?").bind(m).first();
            const nid = crypto.randomUUID();
            await env.DB.prepare("INSERT INTO notifications (id, user_email, type, from_email, from_name, from_pic) VALUES (?, ?, 'follow', ?, ?, ?)").bind(nid, t, m, u?.name || m, u?.picture || "").run();
          } catch (e) {}

          return json({ ok: true, action: "followed" });
        }
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/follow/status" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      const target = (url.searchParams.get("target") || "").toLowerCase();
      if (!me || !target) return json({ status: "none" });
      
      const meFollows = await env.DB.prepare("SELECT 1 FROM follows WHERE follower_email = ? AND following_email = ?").bind(me, target).first();
      const targetFollows = await env.DB.prepare("SELECT 1 FROM follows WHERE follower_email = ? AND following_email = ?").bind(target, me).first();
      
      if (meFollows && targetFollows) return json({ status: "friends" });
      if (meFollows) return json({ status: "following" });
      if (targetFollows) return json({ status: "follower" });
      return json({ status: "none" });
    }

    if (path === "/api/friends/list" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json([]);
      const rows = await env.DB.prepare(`
        SELECT f1.following_email as friend_email 
        FROM follows f1 
        JOIN follows f2 ON f1.following_email = f2.follower_email AND f1.follower_email = f2.following_email
        WHERE f1.follower_email = ?
      `).bind(me).all();
      
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
      const inc = await env.DB.prepare(`
        SELECT f.follower_email as email, u.name, u.picture 
        FROM follows f 
        LEFT JOIN users u ON u.email = f.follower_email 
        WHERE f.following_email = ? AND f.follower_email NOT IN (
           SELECT following_email FROM follows WHERE follower_email = ?
        )
      `).bind(me, me).all();
      return json({ incoming: inc.results || [], outgoing: [] });
    }

    // ⭐ NOTIFICATIONS ROUTES
    if (path === "/api/notifications" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json([]);
      const rows = await env.DB.prepare("SELECT * FROM notifications WHERE user_email = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 50").bind(me).all();
      return json(rows.results || []);
    }
    if (path === "/api/notifications/read" && method === "POST") {
      const { me } = await request.json();
      if (!me) return json({ error: "missing" }, 400);
      await env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE user_email = ?").bind(me.toLowerCase()).run();
      return json({ ok: true });
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
        const { mediaId, visitorId, authorEmail } = await request.json();
        if (!mediaId || !visitorId) return json({ error: "Missing data" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
        
        if (existing) {
          await env.DB.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).run();
        } else {
          await env.DB.prepare("INSERT INTO likes (media_id, visitor_id, user_email) VALUES (?, ?, ?)").bind(mediaId, visitorId, authorEmail || "").run();
          
          // ⭐ INSERT NOTIFICATION FOR LIKE
          try {
            const creatorEmail = await getMediaCreator(env, mediaId);
            if (creatorEmail && creatorEmail !== authorEmail) {
              const u = await env.DB.prepare("SELECT name, picture FROM users WHERE email = ?").bind(authorEmail).first();
              const nid = crypto.randomUUID();
              await env.DB.prepare("INSERT INTO notifications (id, user_email, type, from_email, from_name, from_pic, media_id) VALUES (?, ?, 'like', ?, ?, ?, ?)").bind(nid, creatorEmail, authorEmail, u?.name || authorEmail, u?.picture || "", mediaId).run();
            }
          } catch(e) {}
        }
        const c = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
        mediaCache.ts = 0; return json({ mediaId, count: c ? c.count : 0, liked: !existing });
      } catch (err) { return json({ error: "Database error" }, 500); }
    }

    if (path === "/api/comments" && method === "GET") {
      const mediaId = url.searchParams.get("mediaId");
      if (!mediaId) return json([]);
      const rows = await env.DB.prepare("SELECT id, author_name, author_email, body, created_at FROM comments WHERE media_id = ? ORDER BY created_at ASC LIMIT 200").bind(mediaId).all();
      return json(rows.results || []);
    }
    if (path === "/api/comments" && method === "POST") {
      try {
        const { mediaId, authorName, authorEmail, body } = await request.json();
        if (!mediaId || !body) return json({ error: "Missing data" }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO comments (id, media_id, author_email, author_name, body) VALUES (?, ?, ?, ?, ?)").bind(id, mediaId, authorEmail || "", authorName || "Anonymous", String(body).trim().slice(0, 500)).run();
        
        // ⭐ INSERT NOTIFICATION FOR COMMENT
        try {
            const creatorEmail = await getMediaCreator(env, mediaId);
            if (creatorEmail && creatorEmail !== authorEmail) {
              const u = await env.DB.prepare("SELECT name, picture FROM users WHERE email = ?").bind(authorEmail).first();
              const nid = crypto.randomUUID();
              await env.DB.prepare("INSERT INTO notifications (id, user_email, type, from_email, from_name, from_pic, media_id, content) VALUES (?, ?, 'comment', ?, ?, ?, ?, ?)").bind(nid, creatorEmail, authorEmail, u?.name || authorEmail, u?.picture || "", mediaId, body).run();
            }
        } catch(e) {}

        mediaCache.ts = 0; return json({ ok: true, id });
      } catch (err) { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/block" && method === "POST") {
      try {
        const { me, target } = await request.json();
        if (!me || !target) return json({ error: "missing" }, 400);
        await env.DB.prepare("INSERT OR IGNORE INTO blocked_users (user_email, blocked_email) VALUES (?, ?)").bind(me.toLowerCase(), target.toLowerCase()).run();
        mediaCache.ts = 0; return json({ ok: true });
      } catch { return json({ error: "failed" }, 500); }
    }
    if (path === "/api/report" && method === "POST") {
      try {
        const { mediaId, mediaUrl, reporterEmail, reporterName, reason } = await request.json();
        if (!mediaId || !reason) return json({ error: "Missing data" }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO copyright_reports (id, media_id, media_url, reporter_email, reporter_name, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(id, mediaId, mediaUrl || "", reporterEmail || "", reporterName || "Anonymous", reason).run();
        return json({ ok: true, id });
      } catch { return json({ error: "Failed to save report" }, 500); }
    }

    if (path.startsWith("/api/admin/")) {
      const authz = request.headers.get("authorization") || "";
      const m = authz.match(/^Bearer\s+(.+)$/i);
      const gUser = m ? await verifyGoogleToken(m[1], env.GOOGLE_CLIENT_ID) : null;
      if (!gUser || gUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return json({ error: "Unauthorized." }, 401);
    }
    if (path === "/api/admin/reports" && method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM copyright_reports ORDER BY created_at DESC").all();
      return json(rows.results || []);
    }
    if (path === "/api/admin/delete-video" && method === "POST") {
      const { mediaId, reportId } = await request.json();
      if (mediaId) await env.VIDEOS.delete(mediaId);
      if (reportId) await env.DB.prepare("UPDATE copyright_reports SET status = 'resolved' WHERE id = ?").bind(reportId).run();
      mediaCache.ts = 0; return json({ ok: true });
    }
    if (path === "/api/admin/reject-report" && method === "POST") {
      const { reportId } = await request.json();
      await env.DB.prepare("UPDATE copyright_reports SET status = 'rejected' WHERE id = ?").bind(reportId).run();
      return json({ ok: true });
    }

    if (path === "/api/views" && method === "POST") {
      try {
        const { mediaId, visitorId } = await request.json();
        if (!mediaId || !visitorId) return json({ error: "missing" }, 400);
        await env.DB.prepare("INSERT OR IGNORE INTO media_views (media_id, visitor_id) VALUES (?, ?)").bind(mediaId, visitorId).run();
        return json({ ok: true });
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/watch" && method === "POST") {
      try {
        const b = await request.json();
        const { mediaId, visitorId, seconds, duration, creator, title } = b;
        if (!mediaId || !visitorId || !duration) return json({ error: "missing" }, 400);
        await env.DB.prepare("INSERT INTO watch_events (id, media_id, visitor_id, seconds, duration) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), mediaId, visitorId, Number(seconds) || 0, Number(duration) || 0).run();
        const tags = new Set();
        if (creator) tags.add(`creator:${String(creator).toLowerCase()}`);
        if (title) String(title).toLowerCase().split(/\W+/).filter(w => w.length >= 4).forEach(w => tags.add(`tag:${w}`));
        for (const tag of tags) await env.DB.prepare(`INSERT INTO user_interests (visitor_id, tag, weight, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(visitor_id, tag) DO UPDATE SET weight = weight + 1, updated_at = CURRENT_TIMESTAMP`).bind(visitorId, tag).run();
        return json({ ok: true });
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/recommendations" && method === "GET") {
      try {
        const visitorId = url.searchParams.get("visitorId") || "";
        const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 100);
        const all = await getCachedMedia(env, visitorId);
        const videos = all.filter(m => m.type === "video");
        return json(videos.slice(0, limit)); 
      } catch { return json({ error: "failed" }, 500); }
    }

    if (path === "/api/messages" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      const withEmail = (url.searchParams.get("with") || "").toLowerCase();
      if (!me || !withEmail) return json([]);
      const rows = await env.DB.prepare(`SELECT id, from_email as sender, to_email as recipient, body, created_at FROM messages WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?) ORDER BY created_at ASC LIMIT 500`).bind(me, withEmail, withEmail, me).all();
      await env.DB.prepare("UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE from_email = ? AND to_email = ? AND read_at IS NULL").bind(withEmail, me).run();
      return json(rows.results || []);
    }
    if (path === "/api/messages" && method === "POST") {
      const b = await request.json();
      const from = (b.from || "").toLowerCase(), to = (b.to || "").toLowerCase();
      const body = String(b.body || "").trim().slice(0, 2000);
      if (!from || !to || !body) return json({ error: "missing" }, 400);
      if (from === to) return json({ error: "Cannot message yourself" }, 400);
      await env.DB.prepare("INSERT INTO messages (id, from_email, to_email, body) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), from, to, body).run();
      return json({ ok: true });
    }
    if (path === "/api/conversations" && method === "GET") {
      const me = (url.searchParams.get("me") || "").toLowerCase();
      if (!me) return json([]);
      const rows = await env.DB.prepare(`SELECT CASE WHEN from_email = ? THEN to_email ELSE from_email END AS peer_email, MAX(created_at) AS last_at, SUM(CASE WHEN to_email = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM messages WHERE from_email = ? OR to_email = ? GROUP BY peer_email ORDER BY last_at DESC LIMIT 100`).bind(me, me, me, me).all();
      const peers = (rows.results || []).map(r => r.peer_email);
      if (!peers.length) return json([]);
      const ph = peers.map(() => "?").join(",");
      const users = await env.DB.prepare(`SELECT email, name, picture FROM users WHERE email IN (${ph})`).bind(...peers).all();
      const uMap = Object.fromEntries((users.results || []).map(u => [u.email, u]));
      const out = await Promise.all((rows.results || []).map(async (r) => {
        const last = await env.DB.prepare(`SELECT body, created_at, from_email FROM messages WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?) ORDER BY created_at DESC LIMIT 1`).bind(me, r.peer_email, r.peer_email, me).first();
        return { email: r.peer_email, name: uMap[r.peer_email]?.name || r.peer_email, picture: uMap[r.peer_email]?.picture || "", lastMessage: last?.body || "", lastAt: last?.created_at || r.last_at, lastFromMe: last?.from_email === me, unread: r.unread || 0 };
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
      try { 
        const viewerId = url.searchParams.get("me") || "";
        return json(await getCachedMedia(env, viewerId)); 
      }
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
