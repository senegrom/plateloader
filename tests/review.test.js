'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildAlgoLib } = require('../algo.js');
const { buildStateLib } = require('../state.js');
const algo = buildAlgoLib();
const state = buildStateLib();
const kg = [25, 20, 15, 10, 5, 2.5, 1.25];
const defaults = { input: '', mode: 'count', stock: 2, bar: 20 };

function transition(a, b, mode, sided) {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const moved = a.slice(shared).concat(b.slice(shared));
  const count = moved.length * sided;
  const mass = moved.reduce((sum, i) => sum + kg[i] * sided, 0);
  const sqrt = moved.reduce((sum, i) => sum + Math.sqrt(kg[i]) * sided, 0);
  return mode === 'count' ? [count, mass] : mode === 'kg' ? [mass, count] : [sqrt, count];
}
const better = (a, b) => a[0] < b[0] - 1e-8 || (Math.abs(a[0] - b[0]) < 1e-8 && a[1] < b[1] - 1e-8);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];

// Independent exhaustive stack enumeration and shortest-path oracle. It does
// not use the production interval DP, feasibility encoding or run compression.
function oracle(weights, mode, stock, start, monotonic, sided, leaveLoaded) {
  const caps = stock.slice();
  const counts = kg.map((_, index) => start.filter((plate) => plate === index).length);
  caps.forEach((n, i) => { caps[i] = Math.max(n, counts[i]); });
  const candidates = new Map();
  function visit(stack, remaining, total) {
    if (!candidates.has(total)) candidates.set(total, []);
    candidates.get(total).push(stack.slice());
    for (let i = 0; i < kg.length; i++) {
      if (!remaining[i] || (monotonic && stack.length && i < stack.at(-1))) continue;
      remaining[i]--; stack.push(i);
      visit(stack, remaining, total + sided * kg[i]);
      stack.pop(); remaining[i]++;
    }
  }
  visit([], caps.slice(), 20);
  const sets = weights.filter((weight) => candidates.has(weight)).map((weight) => candidates.get(weight));
  if (!sets.length) return [0, 0];
  if (start.length) sets.unshift([start]);
  let paths = [{ stack: [], cost: [0, 0] }];
  for (const options of sets) {
    paths = options.map((stack) => {
      let best = [Infinity, Infinity];
      for (const previous of paths) {
        const cost = add(previous.cost, transition(previous.stack, stack, mode, sided));
        if (better(cost, best)) best = cost;
      }
      return { stack, cost: best };
    });
  }
  let best = [Infinity, Infinity];
  for (const last of paths) {
    const cost = leaveLoaded ? last.cost : add(last.cost, transition(last.stack, [], mode, sided));
    if (better(cost, best)) best = cost;
  }
  return best;
}

function objective(results, mode) {
  let cost = [0, 0];
  for (const row of results) {
    if (!row.valid) continue;
    for (const item of [row, row.cleanup].filter(Boolean)) {
      cost = add(cost, mode === 'count' ? [item.bothSidesMoves, item.bothSidesKg]
        : mode === 'kg' ? [item.bothSidesKg, item.bothSidesMoves]
          : [item.bothSidesSqrtKg, item.bothSidesMoves]);
    }
  }
  return cost;
}

test('open and closed endings match an independent exact oracle', () => {
  let seed = 1627;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 36; sample++) {
    const stock = [0, 0, 0, random(2), 1 + random(2), random(2), 0];
    const start = sample % 3 ? [] : [4, 5];
    for (const sided of [1, 2]) for (const monotonic of [false, true]) {
      const total = 20 + sided * 2.5 * random(7);
      const weights = [total, total, 21, 20 + sided * 5 * random(4), 20 + sided * 2.5 * random(7)];
      for (const mode of ['count', 'kg', 'sqrt']) for (const leaveLoaded of [false, true]) {
        const results = algo.optimize(weights, mode, stock, kg, 20, start, monotonic, sided, { leaveLoaded });
        const actual = objective(results, mode);
        const expected = oracle(weights, mode, stock, start, monotonic, sided, leaveLoaded);
        assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-8),
          JSON.stringify({ weights, stock, start, mode, monotonic, sided, leaveLoaded, actual, expected }));
        if (leaveLoaded) assert.equal(results.some((row) => row.cleanup), false);
        const valid = results.filter((row) => row.valid);
        if (valid.length) {
          assert.equal(results.filter((row) => row.cleanup).length, leaveLoaded ? 0 : 1);
          for (const row of valid) {
            assert.equal(20 + sided * row.stack.reduce((sum, i) => sum + kg[i], 0), row.total);
          }
        }
      }
    }
  }
});

test('compression retains pinned starts, invalid rows and final cleanup placement', () => {
  const results = algo.optimize([60, 21, 60, 60, 21], 'count', kg.map(() => 2), kg, 20, [4, 2], false, 2);
  assert.equal(results.length, 6);
  assert.deepEqual(results[0].stack, [4, 2]);
  assert.equal(results[2].valid, false);
  assert.equal(results[5].valid, false);
  assert.deepEqual(results[1].stack, results[3].stack);
  assert.deepEqual(results[3].stack, results[4].stack);
  assert.equal(results[3].bothSidesMoves, 0);
  assert.equal(results[4].bothSidesMoves, 0);
  assert.ok(results[4].cleanup);
  assert.notEqual(results[1].stack, results[3].stack, 'expanded stacks must not alias');
});

test('50 high-stock repeated sets finish within the regression budget', () => {
  const script = `const {buildAlgoLib}=require('./algo.js');
    const r=buildAlgoLib().optimize(Array(50).fill(320),'count',Array(7).fill(6),${JSON.stringify(kg)},20,null,false,2);
    if(r.length!==50 || r.slice(1).some(x=>x.bothSidesMoves!==0) || !r[49].cleanup) process.exit(1);`;
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), timeout: 5000, stdio: 'pipe',
  });
});

test('a synchronous deadline aborts instead of returning an approximation', () => {
  assert.throws(() => algo.optimize([320], 'count', kg.map(() => 6), kg, 20, null, false, 2,
    { timeLimitMs: 0 }), { name: 'TimeoutError' });
  assert.ok(algo.optimize([60], 'count', kg.map(() => 2), kg, 20, null, false, 2).every((r) => r.valid));
});

test('end-state and carried inventory are self-contained, bounded shared state', () => {
  const parsed = state.stateFromHash('#w=60&l=1&a=0.8.0.0.0.0.0', defaults);
  assert.equal(parsed.leaveLoaded, true);
  assert.deepEqual(parsed.carriedStock, [0, 8, 0, 0, 0, 0, 0]);
  assert.notEqual(state.stateFromHash('#w=60', defaults).leaveLoaded, true);
  assert.equal(state.stateFromHash('#w=60&a=0.9.0.0.0.0.0', defaults).carriedStock, null);
  assert.equal(state.stateFromHash('#w=60&a=bad', defaults).carriedStock, null);
});

test('worker announces computation start and passes the terminal objective', () => {
  const messages = [];
  const context = vm.createContext({ self: { postMessage: (m) => messages.push(m) }, console });
  context.importScripts = () => vm.runInContext(fs.readFileSync(path.join(__dirname, '../algo.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../algo-worker.js'), 'utf8'), context);
  context.self.onmessage({ data: { reqId: 17, weights: [60], mode: 'count', plateMax: kg.map(() => 2),
    plateKg: kg, BAR: 20, sided: 2, leaveLoaded: true } });
  assert.equal(messages[0].type, 'started');
  assert.equal(messages[0].reqId, 17);
  assert.equal(messages.at(-1).reqId, 17);
  assert.equal(messages.at(-1).results[0].cleanup, undefined);
});
