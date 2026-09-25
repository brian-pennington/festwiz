/* FestWiz — Halloween tracker service worker
 *
 * Scope is /halloween/ only. The ACTIVE app at "/" is the one that claims
 * root scope via the Service-Worker-Allowed header in _headers; while the
 * festival app is live at "/", this worker stays in its own directory.
 * See HALLOWEEN-PLAN.md, Phase 4.
 *
 * NETWORK-FIRST for everything on this origin, with the cache as an offline
 * fallback only.
 *
 * The first version of this file precached the HTML and JS cache-first, which
 * meant every change needed a CACHE_NAME bump to reach anyone — and when that
 * was forgotten, the browser kept serving a stale app that looked like a
 * rendering bug. The payload here is small enough that always asking the
 * network costs little, and being wrong in the other direction (a slightly
 * slower load) is much cheaper than shipping an update nobody receives.
 */

const CACHE_NAME = 'fw-hw-v3';

// Warmed on install so a first-visit-then-offline still works. Nothing is
// ever served from here while the network is reachable.
const WARM = [
  '/',
  '/halloween/',
  '/halloween/index.html',
  '/halloween/style.css',
  '/halloween/halloween.js',
  '/halloween/events.json',
  '/halloween/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // A single failure must not abort the install, so warm them individually.
      .then(cache => Promise.all(
        WARM.map(url => cache.add(url).catch(() => {}))
      ))
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
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // This worker's scope is "/", so it sees the festival app's requests too.
  // That app has its own worker at its own scope; leave its paths alone.
  if (url.pathname.startsWith('/southbysouthwest/')) return;

  event.respondWith(
    fetch(request)
      .then(resp => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(request).then(hit => hit || Response.error()))
  );
});
