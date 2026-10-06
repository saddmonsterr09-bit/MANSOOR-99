const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "video/x-matroska"
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
  return type.split("/")[1].replace("quicktime", "mov");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      const form = await request.formData();
      const file = form.get("video");

      if (!(file instanceof File)) return json({
        error: "A video file is required."
      }, 400);
      if (!ALLOWED_TYPES.has(file.type)) return json({
        error: "This video format is not supported."
      }, 415);
      if (file.size > MAX_FILE_SIZE) return json({
        error: "The maximum file size is 1 GB."
      }, 413);

      const id = `${Date.now()}-${crypto.randomUUID()}`;
      const key = `videos/${id}.${extensionFor(file.type, file.name)}`;
      const title = safeText(form.get("title"), file.name.replace(/\.[^/.]+$/, ""), 120);
      const creator = safeText(form.get("creator"), "Anonymous creator", 80);

      await env.VIDEOS.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type
        },
        customMetadata: {
          title,
          creator,
          uploadedAt: new Date().toISOString()
        }
      });

      return json({
        key,
        title,
        creator,
        url: `/media/${encodeURIComponent(key)}`
      }, 201);
    }

    if (url.pathname === "/api/videos" && request.method === "GET") {
      const listed = await env.VIDEOS.list({
        prefix: "videos/",
        limit: 1000
      });
      const videos = [];

      for (const object of listed.objects) {
        const stored = await env.VIDEOS.head(object.key);
        videos.push({
          key: object.key,
          title: stored?.customMetadata?.title || object.key.split("/").pop(),
          creator: stored?.customMetadata?.creator || "Anonymous creator",
          uploadedAt: stored?.customMetadata?.uploadedAt || object.uploaded.toISOString(),
          url: `/media/${encodeURIComponent(object.key)}`
        });
      }

      videos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return json(videos);
    }

    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!key.startsWith("videos/")) return new Response("Not found", {
        status: 404
      });
      const object = await env.VIDEOS.get(key);
      if (!object) return new Response("Not found", {
        status: 404
      });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      headers.set("access-control-allow-origin", "*");
      return new Response(object.body, {
        headers
      });
    }

    return env.ASSETS ?
      env.ASSETS.fetch(request) :
      new Response("Not found", {
        status: 404
      });
  }
};