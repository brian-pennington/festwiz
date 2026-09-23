/* FestWiz — Halloween tracker service worker
 *
 * Scope is /halloween/ only. The ACTIVE app at "/" is the one that claims
 * root scope via the Service-Worker-Allowed header in _headers; while the
 * festival app is live at "/", this worker stays in its own directory.
 * See HALLOWEEN-PLAN.md, Phase 4.
 *
 * Bump CACHE_NAME after every data push.
 */

const CACHE_NAME = 'fw-hw-v1';

const PRECACHE = [
  '/halloween/',
  '/halloween/index.html',
  '/halloween/halloween.js',
  '/halloween/manifest.json',
];

// events.json and the CSS are network-first so a publish shows up at once;
// the cache is only an offline fallback.
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
        keys.filter(k => k !== CACHE_NAME && k.startsWith('fw-hw-'))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (NETWORK_FIRST.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy));
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request))
  );
});
