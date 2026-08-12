// Plate Loader service worker — offline app-shell cache.
// Known shell assets use stale-while-revalidate; unrelated requests pass through.

const CACHE_PREFIX = 'plateloader-';
const CACHE_VERSION = `${CACHE_PREFIX}v13`;
const APP_SCOPE = self.registration.scope;
const appUrl = (path) => new URL(path, APP_SCOPE).href;
const INDEX_URL = appUrl('index.html');
const SCOPE_PATH = new URL(APP_SCOPE).pathname;
const INDEX_PATH = new URL(INDEX_URL).pathname;
const APP_SHELL = [
  'index.html',
  'plateloader.css',
  'plateloader.js',
  'state.js',
  'algo.js',
  'algo-worker.js',
  'manifest.json',
  'fonts/Inter-400.woff2',
  'fonts/Inter-500.woff2',
  'fonts/Inter-600.woff2',
  'fonts/BebasNeue-400.woff2',
  'fonts/JetBrainsMono-400.woff2',
  'fonts/JetBrainsMono-700.woff2',
  'icons/plateloader-180.png',
  'icons/plateloader-192.png',
  'icons/plateloader-512.png',
  'icons/plateloader-512-maskable.png',
].map(appUrl);
const APP_SHELL_SET = new Set(APP_SHELL);

function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.origin !== location.origin) return null;

  if (request.mode === 'navigate' || request.destination === 'document') {
    return url.pathname === SCOPE_PATH || url.pathname === INDEX_PATH
      ? INDEX_URL : null;
  }

  url.search = '';
  url.hash = '';
  return APP_SHELL_SET.has(url.href) ? url.href : null;
}

self.addEventListener('install', (event) => {
  // Stay in the waiting state until the page's Reload action explicitly asks
  // this worker to activate. That prevents an old page from being controlled
  // by a new asset protocol before it reloads.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_VERSION)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const cacheKey = cacheKeyFor(request);
  if (!cacheKey) return;

  const cachePromise = caches.open(CACHE_VERSION);
  const cachedPromise = cachePromise
    .then((cache) => cache.match(cacheKey))
    .catch(() => null);
  const networkPromise = fetch(cacheKey, { cache: 'no-cache' });
  const refreshPromise = networkPromise
    .then((response) => {
      if (!response || !response.ok) return;
      return cachePromise.then((cache) => cache.put(cacheKey, response.clone()));
    })
    .catch(() => {});

  // Register lifetime extension synchronously while the event is dispatching.
  event.waitUntil(refreshPromise);
  event.respondWith(
    cachedPromise
      .then((cached) => cached || networkPromise)
      .catch(() => {
        if (request.mode !== 'navigate' && request.destination !== 'document') {
          return Response.error();
        }
        return cachePromise
          .then((cache) => cache.match(INDEX_URL))
          .then((fallback) => fallback || Response.error());
      })
  );
});
