const MAX_FILE_SIZE = 90 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
  "video/mp4", "video/quicktime", "video/webm", "video/ogg", "video/x-matroska"
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*"
    }
  });
}

function safeText(value, fallback, maxLength) {
  const text = String(value || "").trim().slice(0, maxLength);
  return text || fallback;
}

function extensionFor(type, name) {
  const fromName = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (fromName) return fromName[1].toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "video/quicktime") return "mov";
  return type.split("/")[1];
}

function mediaUrl(key) {
  return `/media/${encodeURIComponent(key)}`;
}

async function verifyGoogleToken(token, googleClientId) {
  if (!token || !googleClientId) return null;
  try {
    const query = new URLSearchParams({ id_token: token });
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?${query}`);
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.aud !== googleClientId || payload.email_verified !== "true" || !payload.sub) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

// Purana solid listMedia function (Videos wapas laane ke liye)
async function listMedia(env, prefix) {
  const results = [];
  let cursor;
  do {
    const listed = await env.VIDEOS.list({ prefix: `${prefix}/`, limit: 1000, cursor });
    for (const object of listed.objects) {
      const stored = await env.VIDEOS.head(object.key);
      const metadata = stored?.customMetadata || {};
      results.push({
        key: object.key,
        type: metadata.kind || (prefix === "photos" ? "photo" : "video"),
        title: metadata.title || object.key.split("/").pop(),
        creator: metadata.creator || "Anonymous creator",
        creatorEmail: metadata.creatorEmail || "",
        creatorPic: metadata.creatorPic || "",
        uploadedAt: metadata.uploadedAt || object.uploaded.toISOString(),
        url: mediaUrl(object.key)
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization"
        }
      });
    }

    if (url.pathname === "/api/auth/config" && request.method === "GET") {
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    }

    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: "Not configured" }, 503);
      try {
        const body = await request.json();
        const user = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: "Verification failed" }, 401);
        
        return json({
          name: user.name || user.email || "User",
          email: user.email || "",
          picture: user.picture || ""
        });
      } catch (error) {
        return json({ error: "Invalid request" }, 400);
      }
    }

    // NAYA: LIKES API D1 DATABASE KE SATH (Yeh hissa add kiya gaya hai)
    if (url.pathname === "/api/likes" && request.method === "GET") {
      const mediaId = url.searchParams.get("mediaId");
      const visitorId = url.searchParams.get("visitorId");
      
      try {
        const countResult = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
        const userLiked = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
        
        return json({ 
          mediaId, 
          count: countResult ? countResult.count : 0, 
          liked: !!userLiked 
        });
      } catch (err) {
        return json({ error: "Database error", details: err.message }, 500);
      }
    }

    if (url.pathname === "/api/likes" && request.method === "POST") {
      try {
        const body = await request.json();
        const { mediaId, visitorId } = body;
        
        if (!mediaId || !visitorId) return json({ error: "Missing data" }, 400);

        const existingLike = await env.DB.prepare("SELECT * FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).first();
        
        if (existingLike) {
          await env.DB.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?").bind(mediaId, visitorId).run();
        } else {
          await env.DB.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)").bind(mediaId, visitorId).run();
        }
        
        const newCount = await env.DB.prepare("SELECT COUNT(*) as count FROM likes WHERE media_id = ?").bind(mediaId).first();
        
        return json({ 
          mediaId, 
          count: newCount ? newCount.count : 0, 
          liked: !existingLike 
        });
      } catch (err) {
        return json({ error: "Database error", details: err.message }, 500);
      }
    }
    // NAYA Hissa Khatam

    if (url.pathname === "/api/upload" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: "Not configured" }, 503);
      const authorization = request.headers.get("authorization") || "";
      const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
      const googleUser = tokenMatch ? await verifyGoogleToken(tokenMatch[1], env.GOOGLE_CLIENT_ID) : null;
      if (!googleUser) return json({ error: "Sign in first" }, 401);

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
        const creatorEmail = safeText(form.get("creatorEmail"), "", 120);
        const creatorPic = safeText(form.get("creatorPic"), "", 500);
        const uploadedAt = new Date().toISOString();

        await env.VIDEOS.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { kind: type, title, creator, creatorEmail, creatorPic, uploadedAt }
        });

        return json({ key, type, title, creator, creatorPic, uploadedAt, url: mediaUrl(key) }, 201);
      } catch (error) {
        return json({ error: "Upload failed" }, 500);
      }
    }

    if (url.pathname === "/api/media" && request.method === "GET") {
      try {
        const [videos, photos] = await Promise.all([listMedia(env, "videos"), listMedia(env, "photos")]);
        return json([...videos, ...photos].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
      } catch (error) {
        return json({ error: "Could not load media" }, 500);
      }
    }

    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      let key;
      try { key = decodeURIComponent(url.pathname.slice("/media/".length)); } catch { return new Response("Not found", { status: 404 }); }
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
