// R2 binding name is VIDEOS; wrangler.toml connects it to the "personal" bucket.
const MAX_FILE_SIZE = 90 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
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
  if (type === "image/jpeg") return "jpg";
  if (type === "video/quicktime") return "mov";
  return type.split("/")[1];
}

function mediaUrl(key) {
  return `/media/${encodeURIComponent(key)}`;
}

async function listMedia(env, prefix) {
  const results = [];
  let cursor;

  do {
    const listed = await env.VIDEOS.list({
      prefix: `${prefix}/`,
      limit: 1000,
      cursor
    });

    for (const object of listed.objects) {
      const stored = await env.VIDEOS.head(object.key);
      const metadata = stored?.customMetadata || {};
      results.push({
        key: object.key,
        type: metadata.kind || (prefix === "photos" ? "photo" : "video"),
        title: metadata.title || object.key.split("/").pop(),
        creator: metadata.creator || "Anonymous creator",
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
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      try {
        const form = await request.formData();
        const file = form.get("media") || form.get("video");

        if (!(file instanceof File)) {
          return json({
            error: "Choose a photo or video before publishing."
          }, 400);
        }
        if (!ALLOWED_TYPES.has(file.type)) {
          return json({
            error: "This photo or video format is not supported."
          }, 415);
        }
        if (file.size > MAX_FILE_SIZE) {
          return json({
            error: "Photos and videos must be 90 MB or smaller."
          }, 413);
        }

        const isPhoto = file.type.startsWith("image/");
        const type = isPhoto ? "photo" : "video";
        const folder = isPhoto ? "photos" : "videos";
        const id = `${Date.now()}-${crypto.randomUUID()}`;
        const key = `${folder}/${id}.${extensionFor(file.type, file.name)}`;
        const title = safeText(form.get("title"), file.name.replace(/\.[^/.]+$/, ""), 120);
        const creator = safeText(form.get("creator"), "Anonymous creator", 80);
        const uploadedAt = new Date().toISOString();

        await env.VIDEOS.put(key, file.stream(), {
          httpMetadata: {
            contentType: file.type
          },
          customMetadata: {
            kind: type,
            title,
            creator,
            uploadedAt
          }
        });

        return json({
          key,
          type,
          title,
          creator,
          uploadedAt,
          url: mediaUrl(key)
        }, 201);
      } catch (error) {
        return json({
          error: error?.message || "The upload could not be completed."
        }, 500);
      }
    }

    if (url.pathname === "/api/media" && request.method === "GET") {
      try {
        const [videos, photos] = await Promise.all([
          listMedia(env, "videos"),
          listMedia(env, "photos")
        ]);
        return json([...videos, ...photos].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
      } catch (error) {
        return json({
          error: error?.message || "Could not load the public wall."
        }, 500);
      }
    }

    if (url.pathname === "/api/videos" && request.method === "GET") {
      try {
        const videos = await listMedia(env, "videos");
        return json(videos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
      } catch (error) {
        return json({
          error: error?.message || "Could not load videos."
        }, 500);
      }
    }

    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice("/media/".length));
      } catch {
        return new Response("Not found", {
          status: 404
        });
      }

      if (!key.startsWith("videos/") && !key.startsWith("photos/")) {
        return new Response("Not found", {
          status: 404
        });
      }

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
