'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildAlgoLib } = require('../algo.js');
const kg = [25, 20, 15, 10, 5, 2.5, 1.25];
const algo = buildAlgoLib();
const heavy = Array.from({ length: 50 }, (_, index) => index % 2 ? 310 : 320);

// Deliberately independent: enumerates ordered physical stacks and solves the
// small layered shortest-path problem, not the production prefix/interval DP.
function exhaustive(weights, stock, start, bar, sided, monotonic, mode, leaveLoaded) {
  const caps = stock.map((n, i) => Math.max(n, start.filter((p) => p === i).length));
  const candidates = new Map();
  function visit(stack, total) {
    if (!candidates.has(total)) candidates.set(total, []);
    candidates.get(total).push(stack.slice());
    for (let i = 0; i < kg.length; i++) {
      if (!caps[i] || (monotonic && stack.length && i < stack.at(-1))) continue;
      caps[i]--; stack.push(i); visit(stack, total + sided * kg[i]); stack.pop(); caps[i]++;
    }
  }
  visit([], bar);
  function cost(a, b) {
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
    const moved = a.slice(shared).concat(b.slice(shared));
    const count = sided * moved.length;
    const mass = sided * moved.reduce((sum, i) => sum + kg[i], 0);
    const sqrt = sided * moved.reduce((sum, i) => sum + Math.sqrt(kg[i]), 0);
    return mode === 'count' ? [count, mass] : mode === 'kg' ? [mass, count] : [sqrt, count];
  }
  const plus = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const better = (a, b) => a[0] < b[0] - 1e-8 || (Math.abs(a[0] - b[0]) < 1e-8 && a[1] < b[1]);
  const layers = weights.filter((w) => candidates.has(w)).map((w) => candidates.get(w));
  if (!layers.length) return [0, 0];
  if (start.length) layers.unshift([start]);
  let paths = [{ stack: [], cost: [0, 0] }];
  for (const layer of layers) {
    paths = layer.map((stack) => {
      let best = [Infinity, Infinity];
      for (const previous of paths) {
        const candidate = plus(previous.cost, cost(previous.stack, stack));
        if (better(candidate, best)) best = candidate;
      }
      return { stack, cost: best };
    });
  }
  let best = [Infinity, Infinity];
  for (const last of paths) {
    const candidate = leaveLoaded ? last.cost : plus(last.cost, cost(last.stack, []));
    if (better(candidate, best)) best = candidate;
  }
  return best;
}

function objective(results, mode) {
  let moves = 0, mass = 0, sqrt = 0;
  for (const row of results) if (row.valid) {
    for (const step of [row, row.cleanup].filter(Boolean)) {
      moves += step.bothSidesMoves; mass += step.bothSidesKg; sqrt += step.bothSidesSqrtKg;
    }
  }
  return mode === 'count' ? [moves, mass] : mode === 'kg' ? [mass, moves] : [sqrt, moves];
}

test('resumable and synchronous searches match each other and an exhaustive oracle', async () => {
  let seed = 719;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 12; sample++) {
    const stock = [0, 0, 0, random(2), 1, random(2), random(2)];
    const start = sample % 3 ? [] : [4, 6];
    const bar = [0, 15, 20][sample % 3];
    for (const sided of [1, 2]) for (const monotonic of [false, true]) {
      const first = bar + sided * 1.25 * random(13);
      const weights = [first, first, bar + 0.1, bar + sided * 2.5 * random(6), bar + sided * 5];
      for (const mode of ['count', 'kg', 'sqrt']) for (const leaveLoaded of [false, true]) {
        const args = [weights, mode, stock, kg, bar, start, monotonic, sided, { leaveLoaded, sliceMs: 1 }];
        const synchronous = algo.optimize(...args);
        const resumed = await algo.optimizeAsync(...args);
        assert.deepEqual(resumed, synchronous);
        const actual = objective(resumed, mode);
        const expected = exhaustive(weights, stock, start, bar, sided, monotonic, mode, leaveLoaded);
        assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-8),
          JSON.stringify({ sample, sided, monotonic, mode, leaveLoaded, actual, expected }));
      }
    }
  }
});

test('fallback yields to tasks and can be cancelled after the search starts', async () => {
  const controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => { if (++ticks === 4) controller.abort(); }, 10);
  try {
    await assert.rejects(algo.optimizeAsync(heavy, 'count', Array(7).fill(6), kg, 20, null, false, 2,
      { signal: controller.signal, sliceMs: 2 }), { name: 'AbortError' });
    assert.ok(ticks >= 4);
  } finally { clearInterval(timer); }
  assert.deepEqual(await algo.optimizeAsync([60, 80], 'count', Array(7).fill(2), kg, 20, null, false, 2),
    algo.optimize([60, 80], 'count', Array(7).fill(2), kg, 20, null, false, 2));
});

test('async inputs are captured before yielding and concurrent searches remain isolated', async () => {
  const weights = [60, 30], stock = Array(7).fill(2), plates = kg.map((n) => ({ kg: n })), start = [4, 2];
  const options = { leaveLoaded: true };
  const expected = algo.optimize(weights, 'count', stock, plates, 20, start, false, 2, options);
  const pending = algo.optimizeAsync(weights, 'count', stock, plates, 20, start, false, 2, options);
  weights.fill(999); stock.fill(0); plates[4].kg = 500; start.fill(0); options.leaveLoaded = false;
  const other = algo.optimizeAsync([20, 70], 'kg', [1, 0, 0, 0, 0, 0, 0], kg, 20, null, true, 2);
  assert.deepEqual(await pending, expected);
  assert.deepEqual(await other, algo.optimize([20, 70], 'kg', [1, 0, 0, 0, 0, 0, 0], kg, 20, null, true, 2));
});

test('an already aborted request never returns even a trivial solution', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(algo.optimizeAsync([], 'count', Array(7).fill(2), kg, 20, null, false, 2,
    { signal: controller.signal }), { name: 'AbortError' });
});

test('deadline expiry during search is checked in feasibility and interval phases', () => {
  const source = fs.readFileSync(path.join(__dirname, '../algo.js'), 'utf8');
  for (const phase of ['enumerate', 'computeBlock']) {
    let expiredDuring = null;
    const context = vm.createContext({
      performance: { now() {
        const stack = new Error().stack;
        if (stack.includes(phase)) { expiredDuring = phase; return 100; }
        return 0;
      } },
    });
    vm.runInContext(source, context);
    const library = vm.runInContext('buildAlgoLib()', context);
    assert.throws(() => library.optimize([320, 310], 'count', Array(7).fill(6), kg, 20, null, false, 2,
      { timeLimitMs: 50 }), (error) => error.name === 'TimeoutError');
    assert.equal(expiredDuring, phase, `must expire after entering ${phase}, not at initial validation`);
  }
});

test('async timeout rejects without publishing a partial result', async () => {
  await assert.rejects(algo.optimizeAsync(heavy, 'sqrt', Array(7).fill(6), kg, 20, null, false, 2,
    { timeLimitMs: 30, sliceMs: 1 }), { name: 'TimeoutError' });
});


test('many deterministic pauses preserve scratch arenas and exact reconstruction', async () => {
  let ticks = 0, yields = 0;
  const context = vm.createContext({
    performance: { now: () => ++ticks },
    scheduler: { yield: async () => { yields++; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../algo.js'), 'utf8'), context);
  const library = vm.runInContext('buildAlgoLib()', context);
  const weights = [60, 70, 80, 60, 80, 70, 30, 60, 50, 40, 45, 20];
  const stock = [0, 1, 1, 1, 1, 1, 0];
  for (const mode of ['count', 'kg', 'sqrt']) for (const leaveLoaded of [false, true]) {
    const before = yields;
    const results = await library.optimizeAsync(weights, mode, stock, kg, 20, [4, 5], false, 2,
      { leaveLoaded, sliceMs: 1 });
    assert.ok(yields - before > 2, 'exercise actual intermediate suspensions, not just the initial task');
    const expected = exhaustive(weights, stock, [4, 5], 20, 2, false, mode, leaveLoaded);
    const actual = objective(results, mode);
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-8));
    assert.equal(JSON.stringify(results), JSON.stringify(algo.optimize(weights, mode, stock, kg, 20,
      [4, 5], false, 2, { leaveLoaded })));
  }
});
