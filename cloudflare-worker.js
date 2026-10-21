const MAX_FILE_SIZE = 90 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

function safeText(value, fallback, maxLength) {
  const text = String(value || "").trim().slice(0, maxLength);
  return text || fallback;
}

async function verifyGoogleToken(token, googleClientId) {
  if (!token || !googleClientId) return null;
  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.aud !== googleClientId || payload.email_verified !== "true") return null;
    return payload;
  } catch { return null; }
}

async function listMedia(env, prefix) {
  const results = [];
  const listed = await env.VIDEOS.list({ prefix: `${prefix}/`, limit: 1000 });
  for (const object of listed.objects) {
    const stored = await env.VIDEOS.head(object.key);
    const m = stored?.customMetadata || {};
    results.push({
      key: object.key, type: m.kind || (prefix === "photos" ? "photo" : "video"),
      title: m.title || object.key.split("/").pop(), creator: m.creator || "Anonymous",
      creatorPic: m.creatorPic || "", uploadedAt: m.uploadedAt || object.uploaded.toISOString(),
      url: `/media/${encodeURIComponent(object.key)}`
    });
  }
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });

    if (url.pathname === "/api/auth/config") return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });

    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      const body = await request.json();
      const user = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID);
      if (!user) return json({ error: "Verification failed" }, 401);
      return json({ name: user.name || user.email, email: user.email, picture: user.picture || "" });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      const tokenMatch = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
      const googleUser = tokenMatch ? await verifyGoogleToken(tokenMatch[1], env.GOOGLE_CLIENT_ID) : null;
      if (!googleUser) return json({ error: "Sign in first" }, 401);

      const form = await request.formData();
      const file = form.get("media") || form.get("video");
      if (!(file instanceof File)) return json({ error: "No file" }, 400);
      
      const isPhoto = file.type.startsWith("image/");
      const key = `${isPhoto ? "photos" : "videos"}/${Date.now()}-${crypto.randomUUID()}.${file.name.split('.').pop()}`;
      const title = safeText(form.get("title"), file.name, 120);
      const creator = safeText(form.get("creator"), "Anonymous", 80);
      const creatorPic = safeText(form.get("creatorPic"), "", 500);
      const uploadedAt = new Date().toISOString();

      await env.VIDEOS.put(key, file.stream(), { httpMetadata: { contentType: file.type }, customMetadata: { kind: isPhoto ? "photo" : "video", title, creator, creatorPic, uploadedAt } });
      return json({ key, type: isPhoto ? "photo" : "video", title, creator, creatorPic, uploadedAt, url: `/media/${encodeURIComponent(key)}` }, 201);
    }

    if (url.pathname === "/api/media") {
      const [videos, photos] = await Promise.all([listMedia(env, "videos"), listMedia(env, "photos")]);
      return json([...videos, ...photos].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
    }

    if (url.pathname.startsWith("/media/")) {
      const key = decodeURIComponent(url.pathname.slice(7));
      const object = await env.VIDEOS.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=31536000");
      return new Response(object.body, { headers });
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};
