'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildAlgoLib } = require('../algo.js');
const { generateFallback } = require('../scripts/generate-fallback.js');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'algo.js'), 'utf8');
const generated = generateFallback(source);
const plain = buildAlgoLib();
const kg = [25, 20, 15, 10, 5, 2.5, 1.25];
function loadFallback(performance = globalThis.performance) {
  const module = { exports: {} };
  vm.runInNewContext(generated, { module, performance, setTimeout });
  return module.exports.buildFallbackAlgoLib();
}
const fallback = loadFallback();
const normalise = (result) => JSON.parse(JSON.stringify(result));
function cost(a, b, mode, sided) {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const moved = a.slice(shared).concat(b.slice(shared));
  const count = moved.length * sided;
  const mass = moved.reduce((s, p) => s + kg[p] * sided, 0);
  const sqrt = moved.reduce((s, p) => s + Math.sqrt(kg[p]) * sided, 0);
  return mode === 'count' ? [count, mass] : mode === 'kg' ? [mass, count] : [sqrt, count];
}
const better = (a, b) => a[0] < b[0] - 1e-8 || (Math.abs(a[0] - b[0]) < 1e-8 && a[1] < b[1] - 1e-8);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
// Independent enumeration of ordered physical stacks and a shortest-path DP.
// It shares no feasibility encoding, interval recurrence, compression or tables.
function oracle(weights, mode, stock, bar, start, monotonic, sided, leaveLoaded) {
  const available = stock.map((n, p) => Math.max(n, start.filter((q) => p === q).length));
  const candidates = new Map();
  function visit(stack, total) {
    if (!candidates.has(total)) candidates.set(total, []);
    candidates.get(total).push(stack.slice());
    for (let p = 0; p < kg.length; p++) {
      if (!available[p] || (monotonic && stack.length && p < stack.at(-1))) continue;
      available[p]--; stack.push(p);
      visit(stack, total + sided * kg[p]);
      stack.pop(); available[p]++;
    }
  }
  visit([], bar);
  const sets = weights.filter((w) => candidates.has(w)).map((w) => candidates.get(w));
  if (!sets.length) return [0, 0];
  if (start.length) sets.unshift([start]);
  let states = [{ stack: [], value: [0, 0] }];
  for (const options of sets) {
    states = options.map((stack) => {
      let value = [Infinity, Infinity];
      for (const prev of states) {
        const next = add(prev.value, cost(prev.stack, stack, mode, sided));
        if (better(next, value)) value = next;
      }
      return { stack, value };
    });
  }
  let best = [Infinity, Infinity];
  for (const last of states) {
    const value = leaveLoaded ? last.value : add(last.value, cost(last.stack, [], mode, sided));
    if (better(value, best)) best = value;
  }
  return best;
}
function objective(results, mode) {
  let value = [0, 0];
  for (const row of results.filter((r) => r.valid)) {
    for (const x of [row, row.cleanup].filter(Boolean)) {
      value = add(value, mode === 'count' ? [x.bothSidesMoves, x.bothSidesKg]
        : mode === 'kg' ? [x.bothSidesKg, x.bothSidesMoves] : [x.bothSidesSqrtKg, x.bothSidesMoves]);
    }
  }
  return value;
}

test('compact tables and generated fallback match the plain engine and independent oracle', async () => {
  let seed = 7749;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 64; sample++) {
    const stock = [0, 0, 0, random(2), random(2), 1, random(2)];
    const bar = [0, 15, 20][sample % 3];
    const start = sample % 3 ? [] : [4, 5];
    for (const sided of [1, 2]) for (const monotonic of [false, true]) {
      const a = bar + sided * 1.25 * random(10);
      const b = bar + sided * 1.25 * random(10);
      const weights = [a, b, a, b, 21, a, a, bar + sided * 2.5 * random(5)];
      for (const mode of ['count', 'kg', 'sqrt']) for (const leaveLoaded of [false, true]) {
        const args = [weights, mode, stock, kg, bar, start, monotonic, sided];
        const expected = plain.optimize(...args, { leaveLoaded, compactTables: false });
        const compact = plain.optimize(...args, { leaveLoaded, compactTables: true });
        assert.deepEqual(compact, expected, JSON.stringify({ args, leaveLoaded }));
        const actual = objective(compact, mode);
        const independent = oracle(weights, mode, stock, bar, start, monotonic, sided, leaveLoaded);
        assert.ok(actual.every((v, i) => Math.abs(v - independent[i]) < 1e-8));
        // Exercise both generated storage paths, not just the compact solver.
        const asyncResult = await fallback.optimizeAsync(...args, { leaveLoaded, compactTables: sample % 2 === 0 });
        assert.deepEqual(normalise(asyncResult), normalise(expected));
      }
    }
  }
});

test('50 alternating high-stock sets complete within bounded process memory in both ending modes', () => {
  for (const leaveLoaded of [false, true]) {
    const script = `const {buildAlgoLib}=require('./algo.js');
      const weights=Array.from({length:50},(_,i)=>i%2?310:320);
      const result=buildAlgoLib().optimize(weights,'count',Array(7).fill(6),${JSON.stringify(kg)},20,null,false,2,{leaveLoaded:${leaveLoaded}});
      if(result.length!==50 || result.some((r,i)=>!r.valid || r.total!==weights[i] || 20+2*r.stack.reduce((s,p)=>s+${JSON.stringify(kg)}[p],0)!==r.total)) process.exit(1);
      console.log(JSON.stringify({rss:process.resourceUsage().maxRSS, moves:result.reduce((s,r)=>s+r.bothSidesMoves+(r.cleanup?.bothSidesMoves||0),0)}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: root, timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    }));
    // Platform/runtime headroom; the previous engine exceeded 650 MiB before
    // completing. maxRSS is reported in KiB (zero on unsupported platforms).
    assert.ok(result.rss < 320 * 1024, `peak RSS ${result.rss / 1024} MiB`);
    assert.equal(result.moves, leaveLoaded ? 112 : 124);
  }
});

test('fallback compilation is deterministic, isolated and rejects missing source anchors', () => {
  assert.equal(generateFallback(source), generated);
  assert.doesNotMatch(source, /function\*|async function/);
  assert.match(generated, /function\* optimizeSteps/);
  assert.match(generated, /buildFallbackAlgoLib/);
  assert.throws(() => generateFallback(source.replace('function optimize(', 'function renamed(')), /anchor changed/);
  assert.throws(() => generateFallback(source.replace('const sets = weights.map', 'const changed = weights.map')), /anchor changed/);
});

test('fallback yields after work begins, permits timers, cancels and then recovers', async () => {
  const controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => { if (++ticks === 5) controller.abort(); }, 10);
  try {
    await assert.rejects(fallback.optimizeAsync(Array.from({length:50},(_,i)=>i%2?310:320), 'count',
      kg.map(()=>6), kg, 20, null, false, 2, { signal: controller.signal }), { name: 'AbortError' });
    assert.ok(ticks >= 5);
  } finally { clearInterval(timer); }
  assert.deepEqual(normalise(await fallback.optimizeAsync([60,80], 'count', kg.map(()=>2), kg, 20, null, false, 2)),
    plain.optimize([60,80], 'count', kg.map(()=>2), kg, 20, null, false, 2));
});

test('fallback captures mutable inputs and isolates concurrent requests', async () => {
  const weights = [60,80,60]; const stock = kg.map(()=>2); const start = [4];
  const expected = plain.optimize(weights, 'sqrt', stock, kg, 20, start, false, 2, { leaveLoaded: true });
  const work = fallback.optimizeAsync(weights, 'sqrt', stock, kg, 20, start, false, 2, { leaveLoaded: true });
  weights.fill(1000); stock.fill(0); start.push(1);
  const other = fallback.optimizeAsync([30], 'kg', kg.map(()=>2), kg, 20, null, false, 2);
  assert.deepEqual(normalise(await work), expected);
  assert.deepEqual(normalise(await other), plain.optimize([30], 'kg', kg.map(()=>2), kg, 20, null, false, 2));
});

test('periodic mid-search deadlines abort both storage paths and the fallback', async () => {
  for (const compactTables of [false, true]) {
    let calls = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, performance: { now: () => ++calls } });
    assert.throws(() => module.exports.buildAlgoLib().optimize([320,310], 'count', kg.map(()=>6), kg,
      20, null, false, 2, { compactTables, timeLimitMs: 5 }), { name: 'TimeoutError' });
    assert.ok(calls >= 6, 'deadline must not expire at the initial check');
  }
  await assert.rejects(fallback.optimizeAsync(Array.from({length:50},(_,i)=>i%2?310:320), 'count', kg.map(()=>6), kg,
    20, null, false, 2, { timeLimitMs: 50 }), { name: 'TimeoutError' });
});

test('all denominations preserve complete results across disjoint and repeating medium sessions', async () => {
  let seed = 39481;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 120; sample++) {
    const sided = sample % 2 + 1;
    const monotonic = sample % 3 === 0;
    const mode = ['count', 'kg', 'sqrt'][sample % 3];
    const leaveLoaded = sample % 4 < 2;
    const bar = sample % 3 ? 20 : 15;
    const stock = kg.map(() => 1);
    const start = sample % 5 ? null : [0, 4];
    const pattern = Array.from({ length: 3 + random(3) }, () => bar + sided * 1.25 * random(61));
    const weights = Array.from({ length: 12 }, (_, i) => i === 5 ? 21 : pattern[i % pattern.length]);
    const args = [weights, mode, stock, kg, bar, start, monotonic, sided];
    const expected = plain.optimize(...args, { leaveLoaded, compactTables: false });
    assert.deepEqual(plain.optimize(...args, { leaveLoaded, compactTables: true }), expected);
    assert.deepEqual(normalise(await fallback.optimizeAsync(...args, { leaveLoaded, compactTables: true })), normalise(expected));
  }
});
