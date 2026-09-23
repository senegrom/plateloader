'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildAlgoLib } = require('../algo.js');
const kg = [25, 20, 15, 10, 5, 2.5, 1.25];
const algo = buildAlgoLib();

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

test('zero and 15 kg bars, repeated and off-lattice rows match an exhaustive oracle', () => {
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
        const results = algo.optimize(weights, mode, stock, kg, bar, start, monotonic, sided, { leaveLoaded });
        const actual = objective(results, mode);
        const expected = exhaustive(weights, stock, start, bar, sided, monotonic, mode, leaveLoaded);
        assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-8),
          JSON.stringify({ sample, sided, monotonic, mode, leaveLoaded, actual, expected }));
      }
    }
  }
});

// A pinned start admits only its own ordered prefixes, so the first block of
// user sets can reach those plate counts in another order while the start
// cannot. Later repeats of that block reuse its table and need those orders.
test('pinned starts leave other orders of their plates available to later sets', () => {
  for (const [weights, stock, start, mode, leaveLoaded, optimum] of [
    [[190, 60, 190, 60, 195, 200], [1, 1, 1, 1, 1, 1, 1], [2, 0, 1, 0], 'count', false, [52, 970]],
    [[100, 40, 100, 40, 80], [1, 0, 0, 2, 1, 0, 0], [0, 4, 3], 'sqrt', true, [97.65890105634494, 28]],
  ]) {
    const results = algo.optimize(weights, mode, stock, kg, 20, start, false, 2, { leaveLoaded });
    const expected = exhaustive(weights, stock, start, 20, 2, false, mode, leaveLoaded);
    for (const pair of [objective(results, mode), optimum]) {
      assert.ok(pair.every((value, index) => Math.abs(value - expected[index]) < 1e-8),
        JSON.stringify({ weights, start, mode, pair, expected }));
    }
  }
});

test('deadline expiry during search is checked in feasibility and interval phases', () => {
  const source = fs.readFileSync(path.join(__dirname, '../algo.js'), 'utf8');
  for (const phase of ['enumerate', 'solve']) {
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
