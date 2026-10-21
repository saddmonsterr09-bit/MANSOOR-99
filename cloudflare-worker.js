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

const HTML_CONTENT = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ReelsBook</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <link href="https://fonts.googleapis.com/css2?family=Pacifico&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body { background-color: #000000; color: #ffffff; font-family: 'Inter', sans-serif; padding-bottom: 70px; }
    .font-logo { font-family: 'Pacifico', cursive; }
    .hide-scrollbar::-webkit-scrollbar { display: none; }
    .story-ring { background: linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%); padding: 3px; border-radius: 50%; display: inline-block; }
    .story-ring-inner { border: 3px solid #000; border-radius: 50%; padding: 2px; background: #000; overflow: hidden; width: 64px; height: 64px; }
    .post-card { background: #000; border-bottom: 1px solid #27272a; padding-bottom: 1rem; margin-bottom: 1rem; }
    .post-media { width: 100%; max-height: 600px; object-fit: cover; background: #000; }
    #uploadModal { display: none; position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.9); align-items: center; justify-content: center; }
    #uploadModal.is-open { display: flex; }
    .like-btn { display: flex; items-center; gap: 0.5rem; font-size: 1.25rem; cursor: pointer; }
    .liked { color: #ec4899; }
  </style>
</head>
<body>
  <header class="sticky top-0 z-40 bg-black border-b border-gray-800 px-4 py-3 flex items-center justify-between">
    <a href="/" class="text-2xl font-logo text-white">ReelsBook</a>
    <div class="flex items-center gap-5">
      <button id="headerUploadBtn" class="text-white"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg></button>
      <button id="accountButton" class="rounded-full border border-gray-700 px-3 py-1.5 text-sm font-semibold text-white">Log in</button>
    </div>
  </header>

  <main class="max-w-xl mx-auto pt-2">
    <section class="mb-4 border-b border-gray-800 pb-4 px-4">
      <div class="flex gap-4 overflow-x-auto hide-scrollbar">
        <div class="flex flex-col items-center gap-1 cursor-pointer shrink-0" id="addStoryBtn">
          <div class="relative w-16 h-16 rounded-full border border-gray-700 bg-gray-800 flex items-center justify-center">
            <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
          </div>
          <span class="text-xs text-gray-400">Your Story</span>
        </div>
        <div id="storiesContainer" class="flex gap-4"></div>
      </div>
    </section>

    <section id="mediaGrid" class="space-y-4 px-4">
      <div id="loadingFeed" class="text-center py-10 text-gray-500">Loading posts...</div>
    </section>
  </main>

  <nav class="fixed bottom-0 inset-x-0 z-40 bg-black border-t border-gray-800 flex justify-around items-center py-2">
    <a href="#" class="text-white flex flex-col items-center gap-1"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg><span class="text-[10px]">Home</span></a>
    <button id="bottomNavUploadBtn" class="bg-pink-500 text-white rounded-lg p-2"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg></button>
  </nav>

  <div id="uploadModal">
    <div class="bg-gray-900 w-full max-w-md p-6 rounded-xl border border-gray-800 relative">
      <button id="closeUploadBtn" class="absolute top-4 right-4 text-white text-xl">✕</button>
      <h2 class="text-xl font-bold mb-4 text-white">Create Post</h2>
      <div id="googleSignInButton" class="mb-4"></div>
      <input type="file" id="mediaFileInput" class="w-full text-white mb-2 text-sm bg-black p-2 rounded border border-gray-700">
      <input id="mediaTitle" type="text" placeholder="Caption..." class="w-full bg-black border border-gray-700 rounded p-2 text-white mb-2">
      <button id="publishButton" class="w-full bg-pink-500 text-white font-bold py-2 rounded">Publish</button>
      <p id="uploadStatus" class="text-sm text-green-500 mt-2 text-center hidden"></p>
    </div>
  </div>

  <script>
    // --- VISITOR ID (Har user ke liye alag) ---
    function getVisitorId() {
      let v = localStorage.getItem('ReelsbookVisitorId');
      if (!v) { v = crypto.randomUUID(); localStorage.setItem('ReelsbookVisitorId', v); }
      return v;
    }
    const visitorId = getVisitorId();

    // Modals Open/Close
    document.getElementById('headerUploadBtn').onclick = () => document.getElementById('uploadModal').classList.add('is-open');
    document.getElementById('bottomNavUploadBtn').onclick = () => document.getElementById('uploadModal').classList.add('is-open');
    document.getElementById('addStoryBtn').onclick = () => document.getElementById('uploadModal').classList.add('is-open');
    document.getElementById('closeUploadBtn').onclick = () => document.getElementById('uploadModal').classList.remove('is-open');

    // --- LIKE BUTTON FUNCTION (Force Update with Cache Buster) ---
    function createLikeButton(mediaId) {
      const btn = document.createElement('button');
      btn.className = 'like-btn text-gray-400 hover:text-white transition mt-2';
      btn.innerHTML = '<span class="like-icon text-2xl">♡</span><span class="like-count text-sm font-semibold">0</span>';
      
      // Initial Load (Cache Buster Date.now added)
      fetch('/api/likes?mediaId=' + encodeURIComponent(mediaId) + '&visitorId=' + visitorId + '&t=' + Date.now())
        .then(res => res.json())
        .then(data => {
          btn.querySelector('.like-count').textContent = data.count;
          if (data.liked) {
            btn.querySelector('.like-icon').textContent = '♥';
            btn.querySelector('.like-icon').classList.add('liked');
          }
        }).catch(err => console.log("Error loading likes", err));

      // On Click
      btn.onclick = async () => {
        // Disable button temporarily to prevent spam clicking
        btn.disabled = true; 
        try {
          const res = await fetch('/api/likes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mediaId, visitorId })
          });
          const data = await res.json();
          
          if (res.ok) {
            btn.querySelector('.like-count').textContent = data.count;
            const icon = btn.querySelector('.like-icon');
            icon.textContent = data.liked ? '♥' : '♡';
            if(data.liked) { icon.classList.add('liked'); } else { icon.classList.remove('liked'); }
          } else {
            alert("Database Error: " + (data.details || data.error));
          }
        } catch (e) {
          alert("Network Error. Check console.");
          console.error(e);
        } finally {
          btn.disabled = false; // Enable again
        }
      };
      return btn;
    }

    // --- LOAD POSTS ---
    async function loadMedia() {
      document.getElementById('loadingFeed')?.remove();
      try {
        // Add Cache Buster to media list too
        const res = await fetch('/api/media?t=' + Date.now());
        const items = await res.json();
        const grid = document.getElementById('mediaGrid'); grid.innerHTML = '';
        
        if(!items.length) { 
          grid.innerHTML = '<div class="text-center text-gray-500">No posts yet.</div>'; 
          return; 
        }
        
        items.forEach(item => {
          const card = document.createElement('article'); 
          card.className = 'post-card';
          
          // HTML Structure
          card.innerHTML = \`
            <div class="flex items-center gap-3 py-3">
              <div class="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-xs text-white overflow-hidden">
                \${item.creatorPic ? '<img src="'+item.creatorPic+'" class="w-full h-full object-cover">' : (item.creator ? item.creator[0] : 'A')}
              </div>
              <span class="text-sm font-bold text-white">\${item.creator || 'Anonymous'}</span>
            </div>
            \${item.type === 'photo' ? '<img src="'+item.url+'" class="post-media">' : '<video src="'+item.url+'" controls class="post-media"></video>'}
            <div class="pt-2 text-sm text-white font-bold mb-1">\${item.title}</div>
          \`;
          
          // Append dynamic Like Button
          card.appendChild(createLikeButton(item.key));
          grid.appendChild(card);
        });

        // Stories Load
        const stories = document.getElementById('storiesContainer'); stories.innerHTML = '';
        const unique = [...new Map(items.map(i => [i.creator, i])).values()];
        unique.forEach(u => {
          if (!u.creator || u.creator === 'Anonymous') return;
          const s = document.createElement('div'); 
          s.className = 'flex flex-col items-center gap-1 shrink-0';
          s.innerHTML = \`<div class="story-ring"><div class="story-ring-inner flex items-center justify-center bg-gray-800">\${u.creatorPic ? '<img src="'+u.creatorPic+'" class="w-full h-full object-cover rounded-full">' : '<span class="text-white font-bold text-lg">'+u.creator[0]+'</span>'}</div></div><span class="text-xs text-gray-300 w-16 truncate text-center">\${u.creator}</span>\`;
          stories.appendChild(s);
        });
      } catch(e) { 
        document.getElementById('mediaGrid').innerHTML = 'Error loading posts.'; 
        console.error(e);
      }
    }
    loadMedia();
  </script>
</body>
</html>
`;

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
        return json({ name: user.name || user.email || "User", email: user.email || "", picture: user.picture || "" });
      } catch (error) {
        return json({ error: "Invalid request" }, 400);
      }
    }

    // --- LIKES API WITH D1 DATABASE ---
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

    // --- UPLOAD API ---
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
        const id = \`\${Date.now()}-\${crypto.randomUUID()}\`;
        const key = \`\${folder}/\${id}.\${extensionFor(file.type, file.name)}\`;
        
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

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_CONTENT, {
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
};
