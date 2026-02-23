/* Fest Wizard Service Worker — cache-first strategy
 * Bump CACHE_NAME after each artists.json / shows.json data push to force refresh.
 */

const CACHE_NAME = 'sxsw-v43';

const PRECACHE = [
  '/',
  '/index.html',
  '/schedule.html',
  '/style.css',
  '/app.js',
  '/schedule.js',
  '/manifest.json',
  '/artists.json',
  '/shows.json',
  '/unofficial_shows.json',
  '/venues.json',
  '/unofficial_artists.json',
  '/icon-192.png',
  '/icon-512.png',
  '/fest-wiz-trans.png',
];

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
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
