'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'sw.js'), 'utf8');

function createHarness(options = {}) {
  const listeners = {};
  const deletedCaches = [];
  const cacheEntries = new Map(options.cacheEntries || []);
  const cachePuts = [];
  const addedShells = [];
  const fetchCalls = [];
  let claimCalls = 0;
  let skipWaitingCalls = 0;

  const cache = {
    async addAll(urls) { addedShells.push([...urls]); },
    async match(key) { return cacheEntries.get(String(key)); },
    async put(key, response) {
      cachePuts.push(String(key));
      cacheEntries.set(String(key), response);
    },
  };
  const caches = {
    async open() { return cache; },
    async keys() {
      return options.cacheNames || ['plateloader-v10', 'plateloader-v12', 'plateloader-v13', 'other-app-v3'];
    },
    async delete(name) {
      deletedCaches.push(name);
      return true;
    },
  };
  const self = {
    registration: { scope: 'https://example.test/app/' },
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
    location: new URL('https://example.test/app/'),
    URL,
    Set,
    Response,
    Promise,
  }, { filename: 'sw.js' });

  return {
    listeners,
    deletedCaches,
    cacheEntries,
    cachePuts,
    addedShells,
    fetchCalls,
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

test('install precaches the shell but waits for the page to request activation', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.install);
  await lifetime;

  assert.equal(harness.addedShells.length, 1);
  assert.ok(harness.addedShells[0].includes('https://example.test/app/index.html'));
  assert.ok(harness.addedShells[0].includes('https://example.test/app/algo-worker.js'));
  assert.equal(harness.skipWaitingCalls, 0);
});

test('SKIP_WAITING messages explicitly activate the waiting worker', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.message, {
    data: { type: 'SKIP_WAITING' },
  });
  await lifetime;
  assert.equal(harness.skipWaitingCalls, 1);
});

test('activation removes only obsolete Plate Loader caches', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.activate);
  await lifetime;

  assert.deepEqual(harness.deletedCaches, ['plateloader-v10', 'plateloader-v12']);
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
