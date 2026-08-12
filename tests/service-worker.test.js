'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'sw.js'), 'utf8');
const BUILD_PLACEHOLDER = '__PLATELOADER_BUILD_ID__';

function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createHarness(options = {}) {
  const scope = options.scope || 'https://example.test/app/';
  const listeners = {};
  const deletedCaches = [];
  const cacheEntries = new Map(options.cacheEntries || []);
  const cachePuts = [];
  const addedShells = [];
  const fetchCalls = [];
  const openedCaches = [];
  let claimCalls = 0;
  let skipWaitingCalls = 0;

  const cache = {
    async addAll(requests) {
      addedShells.push(requests.map((request) => ({ url: request.url, cache: request.cache })));
    },
    async match(key) { return cacheEntries.get(String(key)); },
    async put(key, response) {
      cachePuts.push(String(key));
      cacheEntries.set(String(key), response);
    },
  };
  const caches = {
    async open(name) {
      openedCaches.push(name);
      return cache;
    },
    async keys() { return options.cacheNames || []; },
    async delete(name) {
      deletedCaches.push(name);
      return true;
    },
  };
  const self = {
    registration: { scope },
    clients: { async claim() { claimCalls++; } },
    async skipWaiting() { skipWaitingCalls++; },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const fetchImpl = options.fetch || (async (request) => {
    fetchCalls.push(typeof request === 'string' ? request : request.url);
    return new Response('network', { status: 200 });
  });

  vm.runInNewContext(source, {
    self,
    caches,
    fetch: async (request) => {
      if (options.fetch) fetchCalls.push(typeof request === 'string' ? request : request.url);
      return fetchImpl(request);
    },
    location: new URL(scope),
    URL,
    Set,
    Request,
    Response,
    Promise,
    Math,
  }, { filename: 'sw.js' });

  return {
    listeners,
    deletedCaches,
    cacheEntries,
    cachePuts,
    addedShells,
    fetchCalls,
    openedCaches,
    get claimCalls() { return claimCalls; },
    get skipWaitingCalls() { return skipWaitingCalls; },
  };
}

function dispatchExtendable(listener, extra = {}) {
  let dispatching = true;
  const lifetimes = [];
  let response;
  const event = {
    ...extra,
    waitUntil(promise) {
      assert.equal(dispatching, true, 'waitUntil must be called during event dispatch');
      lifetimes.push(Promise.resolve(promise));
    },
    respondWith(promise) {
      assert.equal(dispatching, true, 'respondWith must be called during event dispatch');
      response = Promise.resolve(promise);
    },
  };
  listener(event);
  dispatching = false;
  return { lifetime: Promise.all(lifetimes), lifetimes, response };
}

test('install uses a scope-isolated cache, bypasses HTTP cache and waits for explicit activation', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.install);
  await lifetime;

  assert.equal(harness.addedShells.length, 1);
  assert.ok(harness.addedShells[0].some((request) => request.url.endsWith('/index.html')));
  assert.ok(harness.addedShells[0].some((request) => request.url.endsWith('/algo-worker.js')));
  assert.ok(harness.addedShells[0].every((request) => request.cache === 'reload'));
  assert.equal(harness.skipWaitingCalls, 0);
  assert.equal(harness.openedCaches.length, 1);
  assert.match(
    harness.openedCaches[0],
    new RegExp(`^plateloader-${shortHash('https://example.test/app/')}-${BUILD_PLACEHOLDER}$`),
  );
});

test('SKIP_WAITING messages explicitly activate the waiting worker', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.message, {
    data: { type: 'SKIP_WAITING' },
  });
  await lifetime;
  assert.equal(harness.skipWaitingCalls, 1);
});

test('activation removes only this scope generation plus legacy unscoped caches', async () => {
  const scope = 'https://example.test/app/';
  const current = `plateloader-${shortHash(scope)}-${BUILD_PLACEHOLDER}`;
  const oldScoped = `plateloader-${shortHash(scope)}-older-build`;
  const otherScoped = `plateloader-${shortHash('https://example.test/other/')}-other-build`;
  const harness = createHarness({
    scope,
    cacheNames: [current, oldScoped, otherScoped, 'plateloader-v13', 'other-app-v3'],
  });
  const { lifetime } = dispatchExtendable(harness.listeners.activate);
  await lifetime;

  assert.deepEqual(harness.deletedCaches, [oldScoped, 'plateloader-v13']);
  assert.equal(harness.claimCalls, 1);
});

test('known assets are served from canonical cache keys and refreshed in-event', async () => {
  const url = 'https://example.test/app/plateloader.js';
  const harness = createHarness({ cacheEntries: [[url, new Response('cached')]] });
  const request = { method: 'GET', url: `${url}?v=123#ignored`, mode: 'cors', destination: 'script' };
  const { lifetime, response } = dispatchExtendable(harness.listeners.fetch, { request });

  assert.ok(response);
  assert.equal(await (await response).text(), 'cached');
  await lifetime;
  assert.deepEqual(harness.fetchCalls, [url]);
  assert.deepEqual(harness.cachePuts, [url]);
});

test('scope navigation falls back to cached index when offline', async () => {
  const index = 'https://example.test/app/index.html';
  const harness = createHarness({
    cacheEntries: [[index, new Response('offline shell')]],
    fetch: async () => { throw new Error('offline'); },
  });
  const request = {
    method: 'GET',
    url: 'https://example.test/app/#w=100',
    mode: 'navigate',
    destination: 'document',
  };
  const { lifetime, response } = dispatchExtendable(harness.listeners.fetch, { request });
  assert.equal(await (await response).text(), 'offline shell');
  await lifetime;
});

test('unknown, cross-origin and non-GET requests pass through', () => {
  const harness = createHarness();
  const cases = [
    { method: 'GET', url: 'https://example.test/app/random.json', mode: 'cors', destination: '' },
    { method: 'GET', url: 'https://other.test/app/plateloader.js', mode: 'cors', destination: 'script' },
    { method: 'POST', url: 'https://example.test/app/plateloader.js', mode: 'cors', destination: 'script' },
  ];

  for (const request of cases) {
    const dispatched = dispatchExtendable(harness.listeners.fetch, { request });
    assert.equal(dispatched.lifetimes.length, 0);
    assert.equal(dispatched.response, undefined);
  }
});
