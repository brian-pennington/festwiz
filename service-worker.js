/* FestWiz Service Worker
 * JSON data files: network-first (always fresh; cache is offline fallback).
 * Everything else: cache-first (fast app shell loads).
 * Bump CACHE_NAME after each data push to force precache refresh.
 */

const CACHE_NAME = 'fw-v132';

const PRECACHE = [
  '/',
  '/index.html',
  '/schedule',
  '/schedule.html',
  '/style.css',
  '/app.js',
  '/schedule.js',
  '/manifest.json',
  '/announcements.json',
  '/artists.json',
  '/shows.json',
  '/unofficial_shows.json',
  '/venues.json',
  '/unofficial_artists.json',
  '/icon-192.png',
  '/icon-512.png',
  '/fest-wiz-trans.png',
  '/collage-2-color.png',
];

// JSON data files use network-first so schedule.js always gets fresh data.
// Falls back to the cache only when offline.
const DATA_EXTS = /\.json$/;

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

  if (DATA_EXTS.test(url.pathname)) {
    // Network-first for JSON: try network, update cache, fall back to cache
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

  // Cache-first for app shell (HTML, JS, CSS, images)
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
