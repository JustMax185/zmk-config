// App-shell cache. Supabase requests (other origin) are never cached here.
// Bump VERSION together with APP_VERSION in app.js and the ?v= in index.html on every release:
// a changed sw.js makes installed apps update and reload themselves.
const VERSION = '8';
const CACHE = `ausgaben-v${VERSION}`;
const SHELL = ['./', 'index.html', `styles.css?v=${VERSION}`, `app.js?v=${VERSION}`, 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, so updates arrive immediately; fall back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: always ask the server (cheap 304 when unchanged) instead of the HTTP cache
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
