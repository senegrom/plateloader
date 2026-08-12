'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAlgoLib } = require('../algo.js');

const PLATES = [
  { kg: 25, label: '25' },
  { kg: 20, label: '20' },
  { kg: 15, label: '15' },
  { kg: 10, label: '10' },
  { kg: 5, label: '5' },
  { kg: 2.5, label: '2.5' },
  { kg: 1.25, label: '1.25' },
];
const BAR = 20;
const algo = buildAlgoLib();
const EPSILON = 1e-8;

function lexicographicallyBetter(candidate, incumbent) {
  return candidate[0] < incumbent[0] - EPSILON ||
    (candidate[0] <= incumbent[0] + EPSILON && candidate[1] < incumbent[1] - EPSILON);
}

function addPair(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function transitionPair(previous, next, mode, sided) {
  let shared = 0;
  while (
    shared < previous.length &&
    shared < next.length &&
    previous[shared] === next[shared]
  ) shared++;

  const moved = previous.slice(shared).concat(next.slice(shared));
  let count = moved.length * sided;
  let kg = 0;
  let sqrtKg = 0;
  for (const plateIdx of moved) {
    kg += PLATES[plateIdx].kg * sided;
    sqrtKg += Math.sqrt(PLATES[plateIdx].kg) * sided;
  }

  if (mode === 'count') return [count, kg];
  if (mode === 'kg') return [kg, count];
  return [sqrtKg, count];
}

function countCombinations(targetUnits, plateMax) {
  const units = PLATES.map((plate) => Math.round(plate.kg * 4));
  const counts = new Array(PLATES.length).fill(0);
  const output = [];

  function visit(index, remaining) {
    if (remaining === 0) {
      output.push(counts.slice());
      return;
    }
    if (index >= PLATES.length) return;

    const maxCount = Math.min(plateMax[index], Math.floor(remaining / units[index]));
    for (let count = 0; count <= maxCount; count++) {
      counts[index] = count;
      visit(index + 1, remaining - count * units[index]);
    }
    counts[index] = 0;
  }

  visit(0, targetUnits);
  return output;
}

function orderedStacks(counts, monotonic) {
  if (monotonic) {
    const stack = [];
    for (let plateIdx = 0; plateIdx < counts.length; plateIdx++) {
      for (let count = 0; count < counts[plateIdx]; count++) stack.push(plateIdx);
    }
    return [stack];
  }

  const remaining = counts.slice();
  const length = counts.reduce((sum, count) => sum + count, 0);
  const stack = [];
  const output = [];

  function visit() {
    if (stack.length === length) {
      output.push(stack.slice());
      return;
    }
    for (let plateIdx = 0; plateIdx < remaining.length; plateIdx++) {
      if (remaining[plateIdx] === 0) continue;
      remaining[plateIdx]--;
      stack.push(plateIdx);
      visit();
      stack.pop();
      remaining[plateIdx]++;
    }
  }

  visit();
  return output;
}

function candidatesForWeight(total, plateMax, monotonic, sided) {
  const perSide = (total - BAR) / sided;
  const targetUnits = Math.round(perSide * 4);
  if (total < BAR || perSide < 0 || Math.abs(targetUnits - perSide * 4) > EPSILON) return [];

  const unique = new Map();
  for (const counts of countCombinations(targetUnits, plateMax)) {
    for (const stack of orderedStacks(counts, monotonic)) unique.set(stack.join(','), stack);
  }
  return [...unique.values()];
}

function oracleObjective(weights, mode, plateMax, startStack, monotonic, sided) {
  const effectiveMax = plateMax.slice();
  const sets = [];

  if (startStack && startStack.length) {
    const pinned = monotonic ? startStack.slice().sort((a, b) => a - b) : startStack.slice();
    const startCounts = new Array(PLATES.length).fill(0);
    for (const plateIdx of pinned) startCounts[plateIdx]++;
    for (let plateIdx = 0; plateIdx < effectiveMax.length; plateIdx++) {
      effectiveMax[plateIdx] = Math.max(effectiveMax[plateIdx], startCounts[plateIdx]);
    }
    sets.push([pinned]);
  }

  for (const weight of weights) {
    sets.push(candidatesForWeight(weight, effectiveMax, monotonic, sided));
  }

  let total = [0, 0];
  let index = 0;
  while (index < sets.length) {
    if (sets[index].length === 0) {
      index++;
      continue;
    }

    let end = index;
    while (end + 1 < sets.length && sets[end + 1].length > 0) end++;

    let states = new Map([['', { stack: [], cost: [0, 0] }]]);
    for (let setIndex = index; setIndex <= end; setIndex++) {
      const nextStates = new Map();
      for (const nextStack of sets[setIndex]) {
        let best = [Infinity, Infinity];
        for (const { stack: previousStack, cost } of states.values()) {
          const candidate = addPair(cost, transitionPair(previousStack, nextStack, mode, sided));
          if (lexicographicallyBetter(candidate, best)) best = candidate;
        }
        nextStates.set(nextStack.join(','), { stack: nextStack, cost: best });
      }
      states = nextStates;
    }

    let bestRun = [Infinity, Infinity];
    for (const { stack, cost } of states.values()) {
      const candidate = addPair(cost, transitionPair(stack, [], mode, sided));
      if (lexicographicallyBetter(candidate, bestRun)) bestRun = candidate;
    }
    total = addPair(total, bestRun);
    index = end + 1;
  }

  return total;
}

function resultObjective(results, mode) {
  let count = 0;
  let kg = 0;
  let sqrtKg = 0;
  for (const result of results) {
    if (!result.valid) continue;
    count += result.bothSidesMoves;
    kg += result.bothSidesKg;
    sqrtKg += result.bothSidesSqrtKg;
    if (result.cleanup) {
      count += result.cleanup.bothSidesMoves;
      kg += result.cleanup.bothSidesKg;
      sqrtKg += result.cleanup.bothSidesSqrtKg;
    }
  }
  if (mode === 'count') return [count, kg];
  if (mode === 'kg') return [kg, count];
  return [sqrtKg, count];
}

function assertPairClose(actual, expected, context) {
  assert.ok(Math.abs(actual[0] - expected[0]) < EPSILON,
    `${context}: primary ${actual[0]} !== ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) < EPSILON,
    `${context}: secondary ${actual[1]} !== ${expected[1]}`);
}

function checkAgainstOracle({ weights, stock = 1, startStack = null, monotonic = false, sided = 2 }) {
  const plateMax = PLATES.map(() => stock);
  for (const mode of ['count', 'kg', 'sqrt']) {
    const results = algo.optimize(
      weights.slice(),
      mode,
      plateMax.slice(),
      PLATES,
      BAR,
      startStack && startStack.slice(),
      monotonic,
      sided,
    );
    const actual = resultObjective(results, mode);
    const expected = oracleObjective(weights, mode, plateMax, startStack, monotonic, sided);
    assertPairClose(actual, expected,
      JSON.stringify({ weights, mode, stock, startStack, monotonic, sided }));
  }
}

test('selected two-sided, one-sided, monotonic and pinned-start cases match an exhaustive oracle', () => {
  const cases = [
    { weights: [20, 30, 40, 50] },
    { weights: [50, 30, 50] },
    { weights: [35, 42.5, 47.5], stock: 2 },
    { weights: [25, 35, 45], sided: 1 },
    { weights: [30, 40, 50], monotonic: true },
    { weights: [40, 45, 50], startStack: [3, 4] },
    { weights: [40, 45, 50], startStack: [4, 3] },
    { weights: [35, 45], startStack: [4, 3], monotonic: true },
  ];
  for (const testCase of cases) checkAgainstOracle(testCase);
});

test('deterministic random small-domain cases match the exhaustive oracle', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const twoSidedWeights = [20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50];
  const oneSidedWeights = [20, 21.25, 22.5, 25, 27.5, 30, 35, 40, 45, 50];
  const startStacks = [null, [1], [3, 4], [4, 3], [5, 6]];

  for (let caseIndex = 0; caseIndex < 40; caseIndex++) {
    const sided = random() < 0.35 ? 1 : 2;
    const source = sided === 1 ? oneSidedWeights : twoSidedWeights;
    const length = 1 + Math.floor(random() * 4);
    const weights = Array.from({ length }, () => source[Math.floor(random() * source.length)]);
    checkAgainstOracle({
      weights,
      stock: random() < 0.25 ? 2 : 1,
      startStack: startStacks[Math.floor(random() * startStacks.length)],
      monotonic: random() < 0.4,
      sided,
    });
  }
});

test('invalid weights report stable reasons and split optimisation runs', () => {
  const plateMax = PLATES.map(() => 1);
  const results = algo.optimize([15, 20.25, 500, 30], 'count', plateMax, PLATES, BAR, null, false, 2);

  assert.equal(results[0].valid, false);
  assert.match(results[0].reason, /Below bar weight/);
  assert.equal(results[1].valid, false);
  assert.match(results[1].reason, /Not achievable/);
  assert.equal(results[2].valid, false);
  assert.match(results[2].reason, /No plate combination/);
  assert.equal(results[3].valid, true);
  assert.equal(results[3].isStart, true);
  assert.ok(results[3].cleanup);
});

test('a pinned starting stack remains ordered and can exceed the selected stock cap', () => {
  const plateMax = PLATES.map(() => 0);
  const results = algo.optimize([60], 'count', plateMax, PLATES, BAR, [1], false, 2);

  assert.equal(results.length, 2);
  assert.deepEqual(results[0].stack, [1]);
  assert.equal(results[0].valid, true);
  assert.equal(results[1].valid, true);
  assert.deepEqual(results[1].stack, [1]);
});
