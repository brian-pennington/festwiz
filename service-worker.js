/* FestWiz Service Worker
 * JSON data files + CSS: network-first (always fresh; cache is offline fallback).
 * Everything else: cache-first (fast app shell loads).
 *
 * Only small, stable app-shell files are in PRECACHE so cache.addAll() never
 * fails due to large data files timing out during install.  JSON + CSS are
 * picked up by the network-first handler on first use and cached there.
 *
 * Bump CACHE_NAME after each data push to force precache refresh.
 */

const CACHE_NAME = 'fw-v149';

const PRECACHE = [
  '/',
  '/index.html',
  '/schedule',
  '/schedule.html',
  '/app.js',
  '/schedule.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/fest-wiz-trans.png',
  '/collage-2-color.png',
];

// JSON data files AND CSS use network-first:
//   - JSON: schedule.js always gets fresh show/artist data
//   - CSS: style changes deploy immediately without waiting for a precache cycle
// Falls back to the cache only when offline.
const NETWORK_FIRST = /\.(json|css)$/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (NETWORK_FIRST.test(url.pathname)) {
    // Network-first for JSON + CSS: try network, update cache, fall back to cache
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for app shell (HTML, JS, images)
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
