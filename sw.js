const CACHE_VERSION = 'reelsbook-v4'; // Version update kiya
const STATIC_CACHE  = CACHE_VERSION + '-static';
const CDN_CACHE     = CACHE_VERSION + '-cdn';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

const PRECACHE_ASSETS = [
  '/', '/index.html', '/theme.css', '/manifest.json', '/icon.png', '/SAD.jpg',
  '/reels/index.html', '/profile/index.html'
];

const CACHEABLE_CDN = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://accounts.google.com/gsi/client'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE_ASSETS.map(async (url) => {
      try { const res = await fetch(url, { cache: 'reload' }); if (res.ok) await cache.put(url, res); } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  const isCdn = CACHEABLE_CDN.some((origin) => req.url.startsWith(origin));
  if (isCdn) { event.respondWith(cacheFirst(req, CDN_CACHE)); return; }

  const acceptsHtml = req.headers.get('accept')?.includes('text/html');
  if (req.mode === 'navigate' || acceptsHtml) { event.respondWith(networkFirstHtml(req)); return; }

  if (url.origin === self.location.origin) { event.respondWith(cacheFirst(req, STATIC_CACHE)); return; }

  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try { const res = await fetch(req); if (res && res.ok) cache.put(req, res.clone()); return res; } 
  catch { return new Response('', { status: 503 }); }
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
    const root = await cache.match('/');
    if (root) return root;
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached || new Response('', { status: 503 }));
  return cached || networkPromise;
}
