// Plate Loader service worker — immutable, versioned offline app-shell cache.

const BUILD_ID = '__PLATELOADER_BUILD_ID__';
const APP_SCOPE = self.registration.scope;
const appUrl = (path) => new URL(path, APP_SCOPE).href;
const INDEX_URL = appUrl('index.html');
const SCOPE_PATH = new URL(APP_SCOPE).pathname;
const INDEX_PATH = new URL(INDEX_URL).pathname;

// Cache names are strings, so using the complete registration scope is both
// simpler and collision-free. Only generations belonging to this exact scope
// are ever removed during activation.
const CACHE_PREFIX = `plateloader:${APP_SCOPE}:`;
const CACHE_VERSION = `${CACHE_PREFIX}${BUILD_ID}`;
const APP_SHELL = [
  'index.html',
  'plateloader.css',
  'plateloader.js',
  'state.js',
  'algo.js',
  'algo-worker.js',
  'manifest.json',
  'fonts/Inter-400.woff2',
  'fonts/BebasNeue-400.woff2',
  'fonts/JetBrainsMono-400.woff2',
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
  // Stay waiting until the page's Reload action explicitly asks this worker
  // to activate. Populate a fresh generation without consulting HTTP cache.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(
        APP_SHELL.map((url) => new Request(url, { cache: 'reload' })),
      )),
  );
});

async function activateCurrentGeneration() {
  let names = [];
  try { names = await caches.keys(); } catch (_) {}
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_VERSION)
      .map(async (name) => {
        try { await caches.delete(name); } catch (_) {}
      }),
  );
  try { await self.clients.claim(); } catch (_) {}
}

self.addEventListener('activate', (event) => {
  event.waitUntil(activateCurrentGeneration());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

async function cachedShellResponse(cacheKey, isNavigation) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch (_) {}

  let response = null;
  try {
    response = await fetch(new Request(cacheKey, { cache: 'reload' }));
  } catch (_) {}

  if (response) {
    if (cache && response.ok) {
      try { await cache.put(cacheKey, response.clone()); } catch (_) {}
    }
    return response;
  }

  if (isNavigation && cache) {
    try { return await cache.match(INDEX_URL) || Response.error(); } catch (_) {}
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers && request.headers.has('range')) return;

  const cacheKey = cacheKeyFor(request);
  if (!cacheKey) return;

  const isNavigation = request.mode === 'navigate' || request.destination === 'document';
  event.respondWith(cachedShellResponse(cacheKey, isNavigation));
});
