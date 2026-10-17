self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('reelsbook-v1').then((cache) => cache.addAll(['/', '/index.html', '/theme.css'])));
});
self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((response) => response || fetch(e.request)));
});
