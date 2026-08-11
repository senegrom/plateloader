// Plate Loader service worker — offline cache.
// Strategy: cache-first for the app shell, network-first for everything else.
// Bump CACHE_VERSION when shell files change to evict old caches.

const CACHE_VERSION = 'plateloader-v10';
const APP_SCOPE = self.registration.scope;
const appUrl = (path) => new URL(path, APP_SCOPE).href;
const APP_SHELL = [
  appUrl('plateloader.html'),
  appUrl('plateloader.js'),
  appUrl('algo.js'),
  appUrl('manifest.json'),
  appUrl('fonts/Inter-400.woff2'),
  appUrl('fonts/Inter-500.woff2'),
  appUrl('fonts/Inter-600.woff2'),
  appUrl('fonts/BebasNeue-400.woff2'),
  appUrl('fonts/JetBrainsMono-400.woff2'),
  appUrl('fonts/JetBrainsMono-700.woff2'),
  appUrl('icons/plateloader-180.png'),
  appUrl('icons/plateloader-192.png'),
  appUrl('icons/plateloader-512.png'),
  appUrl('icons/plateloader-512-maskable.png'),
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests within this deployment's scope.
  if (url.origin !== location.origin) return;
  if (!url.pathname.startsWith(new URL(APP_SCOPE).pathname)) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh in the background.
        fetch(req).then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE_VERSION).then((c) => c.put(req, res.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => {
        // Only fall back to the app shell for navigation requests.
        // For images/fonts/JS/etc., let the failure propagate so the
        // browser shows the actual error (e.g. broken-image icon)
        // instead of returning HTML as an image's bytes.
        if (req.mode === 'navigate' || req.destination === 'document') {
          return caches.match(appUrl('plateloader.html'));
        }
        return Response.error();
      });
    })
  );
});
