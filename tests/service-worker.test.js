'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'sw.js'), 'utf8');
const BUILD_PLACEHOLDER = '__PLATELOADER_BUILD_ID__';

function cachePrefix(scope) {
  return `plateloader:${scope}:`;
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
      if (options.addAllError) throw new Error('addAll failed');
      addedShells.push(requests.map((request) => ({ url: request.url, cache: request.cache })));
    },
    async match(key) {
      if (options.matchError) throw new Error('match failed');
      return cacheEntries.get(String(key));
    },
    async put(key, response) {
      cachePuts.push(String(key));
      if (options.putError) throw new Error('put failed');
      cacheEntries.set(String(key), response);
    },
  };
  const caches = {
    async open(name) {
      openedCaches.push(name);
      if (options.openError) throw new Error('open failed');
      return cache;
    },
    async keys() {
      if (options.keysError) throw new Error('keys failed');
      return options.cacheNames || [];
    },
    async delete(name) {
      deletedCaches.push(name);
      if (options.deleteError || (options.deleteErrors || []).includes(name)) {
        throw new Error('delete failed');
      }
      return true;
    },
  };
  const self = {
    registration: { scope },
    clients: {
      async claim() {
        claimCalls++;
        if (options.claimError) throw new Error('claim failed');
      },
    },
    async skipWaiting() { skipWaitingCalls++; },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const recordFetch = (request) => fetchCalls.push({
    url: typeof request === 'string' ? request : request.url,
    cache: typeof request === 'string' ? undefined : request.cache,
  });
  const fetchImpl = options.fetch || (async () => new Response('network', { status: 200 }));

  vm.runInNewContext(source, {
    self,
    caches,
    fetch: async (request) => {
      recordFetch(request);
      return fetchImpl(request);
    },
    location: new URL(scope),
    URL,
    Set,
    Request,
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

test('install uses an exact scope-isolated cache, bypasses HTTP cache and waits for explicit activation', async () => {
  const scope = 'https://example.test/app/';
  const harness = createHarness({ scope });
  const { lifetime } = dispatchExtendable(harness.listeners.install);
  await lifetime;

  assert.equal(harness.addedShells.length, 1);
  assert.ok(harness.addedShells[0].some((request) => request.url.endsWith('/index.html')));
  assert.ok(harness.addedShells[0].some((request) => request.url.endsWith('/algo-worker.js')));
  assert.ok(harness.addedShells[0].every((request) => request.cache === 'reload'));
  assert.equal(harness.skipWaitingCalls, 0);
  assert.deepEqual(harness.openedCaches, [`${cachePrefix(scope)}${BUILD_PLACEHOLDER}`]);
});

test('SKIP_WAITING messages explicitly activate the waiting worker', async () => {
  const harness = createHarness();
  const { lifetime } = dispatchExtendable(harness.listeners.message, {
    data: { type: 'SKIP_WAITING' },
  });
  await lifetime;
  assert.equal(harness.skipWaitingCalls, 1);
});

test('activation removes only obsolete generations for this exact deployment scope', async () => {
  const scope = 'https://example.test/app/';
  const current = `${cachePrefix(scope)}${BUILD_PLACEHOLDER}`;
  const oldScoped = `${cachePrefix(scope)}older-build`;
  const otherScoped = `${cachePrefix('https://example.test/other/')}other-build`;
  const harness = createHarness({
    scope,
    cacheNames: [current, oldScoped, otherScoped, 'plateloader-v13', 'other-app-v3'],
  });
  const { lifetime } = dispatchExtendable(harness.listeners.activate);
  await lifetime;

  assert.deepEqual(harness.deletedCaches, [oldScoped]);
  assert.equal(harness.claimCalls, 1);
});

test('activation remains successful when cache enumeration or deletion fails', async () => {
  const scope = 'https://example.test/app/';
  const oldScoped = `${cachePrefix(scope)}older-build`;
  let harness = createHarness({ scope, cacheNames: [oldScoped], deleteError: true });
  let dispatched = dispatchExtendable(harness.listeners.activate);
  await dispatched.lifetime;
  assert.deepEqual(harness.deletedCaches, [oldScoped]);
  assert.equal(harness.claimCalls, 1);

  harness = createHarness({ scope, keysError: true, claimError: true });
  dispatched = dispatchExtendable(harness.listeners.activate);
  await dispatched.lifetime;
  assert.equal(harness.claimCalls, 1);
});

test('cached shell assets are immutable and never refreshed by an older worker', async () => {
  const url = 'https://example.test/app/plateloader.js';
  const harness = createHarness({ cacheEntries: [[url, new Response('cached')]] });
  const request = { method: 'GET', url: `${url}?v=123#ignored`, mode: 'cors', destination: 'script' };
  const { lifetimes, response } = dispatchExtendable(harness.listeners.fetch, { request });

  assert.ok(response);
  assert.equal(await (await response).text(), 'cached');
  assert.equal(lifetimes.length, 0);
  assert.deepEqual(harness.fetchCalls, []);
  assert.deepEqual(harness.cachePuts, []);
});

test('a shell cache miss bypasses HTTP cache and is stored in the current generation', async () => {
  const url = 'https://example.test/app/plateloader.js';
  const harness = createHarness();
  const request = { method: 'GET', url: `${url}?v=123`, mode: 'cors', destination: 'script' };
  const { response } = dispatchExtendable(harness.listeners.fetch, { request });

  assert.equal(await (await response).text(), 'network');
  assert.deepEqual(harness.fetchCalls, [{ url, cache: 'reload' }]);
  assert.deepEqual(harness.cachePuts, [url]);
});

test('cache failures never discard a successful network response', async () => {
  const url = 'https://example.test/app/plateloader.js';
  const request = { method: 'GET', url, mode: 'cors', destination: 'script' };

  for (const options of [
    { openError: true },
    { matchError: true },
    { putError: true },
  ]) {
    const harness = createHarness(options);
    const { response } = dispatchExtendable(harness.listeners.fetch, { request });
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'network');
    assert.deepEqual(harness.fetchCalls, [{ url, cache: 'reload' }]);
  }
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
  const { response } = dispatchExtendable(harness.listeners.fetch, { request });
  assert.equal(await (await response).text(), 'offline shell');
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
