'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const algorithmSource = fs.readFileSync(path.join(root, 'algo.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'algo-worker.js'), 'utf8');
const plateKg = [25, 20, 15, 10, 5, 2.5, 1.25];

function dispatch(data) {
  let posted = null;
  const context = vm.createContext({
    self: {
      postMessage(message) { posted = message; },
      onmessage: null,
    },
    console,
  });
  context.importScripts = (file) => {
    assert.equal(file, 'algo.js');
    vm.runInContext(algorithmSource, context, { filename: 'algo.js' });
  };
  vm.runInContext(workerSource, context, { filename: 'algo-worker.js' });
  context.self.onmessage({ data });
  return posted;
}

function request(overrides = {}) {
  return {
    reqId: 7,
    weights: [60],
    mode: 'count',
    plateMax: plateKg.map(() => 2),
    plateKg,
    BAR: 20,
    startStack: null,
    monotonic: false,
    sided: 2,
    ...overrides,
  };
}

test('worker reports whether a pinned starting state is present in its result', () => {
  let message = dispatch(request({ startStack: [1] }));
  assert.equal(message.reqId, 7);
  assert.equal(message.hasStart, true);
  assert.equal(message.results.length, 2);

  message = dispatch(request({ weights: [61], startStack: [1] }));
  assert.equal(message.hasStart, false);
  assert.equal(message.results.length, 1);
  assert.equal(message.results[0].valid, false);

  message = dispatch(request());
  assert.equal(message.hasStart, false);
});

test('worker converts optimiser exceptions into request-scoped errors', () => {
  const message = dispatch(request({
    startStack: [4, 3],
    monotonic: true,
  }));
  assert.equal(message.reqId, 7);
  assert.match(message.error, /starting stack must be ordered heaviest to lightest/);
  assert.equal('results' in message, false);
});
