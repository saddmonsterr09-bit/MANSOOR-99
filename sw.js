/* ReelsBook Service Worker v3 — Offline-first */

const CACHE_VERSION = 'reelsbook-v3';
const STATIC_CACHE  = CACHE_VERSION + '-static';
const CDN_CACHE     = CACHE_VERSION + '-cdn';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// Same-origin files that must be available offline
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/theme.css',
  '/manifest.json',
  '/icon.png',
  '/SAD.jpg',
  '/reels/index.html',
  '/reels/',
  '/profile/index.html',
  '/profile/'
];

// External origins we want cached for offline (Tailwind, Fonts, Google)
const CACHEABLE_CDN = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://accounts.google.com/gsi/client'
];

/* ---------- INSTALL ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        console.warn('[SW] Precache skipped:', url);
      }
    }));
    self.skipWaiting();
  })());
});

/* ---------- ACTIVATE ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- FETCH ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API + media — always network (never intercept)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  // CDN assets (Tailwind, Fonts, Google) — cache-first
  const isCdn = CACHEABLE_CDN.some((origin) => req.url.startsWith(origin));
  if (isCdn) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // HTML navigation — network-first with offline fallback
  const acceptsHtml = req.headers.get('accept')?.includes('text/html');
  if (req.mode === 'navigate' || acceptsHtml) {
    event.respondWith(networkFirstHtml(req));
    return;
  }

  // Same-origin static (CSS, JS, images) — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Everything else
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

/* ---------- STRATEGIES ---------- */

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 503 });
  }
}

async function networkFirstHtml(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;

    const url = new URL(req.url);
    const altUrl = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname + '/index.html';
    const alt = await cache.match(altUrl);
    if (alt) return alt;

    const root = await cache.match('/');
    if (root) return root;

    // Final fallback — inline offline page (always works)
    return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline — ReelsBook</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;}
h1{font-size:28px;margin:0 0 12px;}
p{color:#a1a1aa;margin:0 0 20px;}
a{display:inline-block;background:#ef4444;color:#fff;text-decoration:none;padding:10px 20px;border-radius:999px;font-weight:700;}
</style>
</head><body>
<div>
  <h1>📡 You're offline</h1>
  <p>ReelsBook can't connect right now. Check your internet and try again.</p>
  <a href="/" onclick="location.reload()">Retry</a>
</div>
</body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached || new Response('', { status: 503 }));
  return cached || networkPromise;
}

/* ---------- MESSAGE ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});
