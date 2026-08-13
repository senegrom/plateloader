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
  const count = moved.length * sided;
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
  if (
    !Number.isFinite(total) ||
    total < BAR ||
    perSide < 0 ||
    Math.abs(targetUnits - perSide * 4) > EPSILON
  ) return [];

  const unique = new Map();
  for (const counts of countCombinations(targetUnits, plateMax)) {
    for (const stack of orderedStacks(counts, monotonic)) unique.set(stack.join(','), stack);
  }
  return [...unique.values()];
}

// Invalid entries are annotations rather than bar states. The oracle therefore
// removes impossible entries and optimises every remaining valid set together.
function oracleObjective(weights, mode, plateMax, startStack, monotonic, sided) {
  const effectiveMax = plateMax.slice();
  let pinned = null;

  if (startStack && startStack.length) {
    pinned = startStack.slice();
    if (monotonic) {
      for (let index = 1; index < pinned.length; index++) {
        if (pinned[index] < pinned[index - 1]) {
          throw new RangeError('Monotonic starting stack must be ordered heaviest to lightest');
        }
      }
    }
    const startCounts = new Array(PLATES.length).fill(0);
    for (const plateIdx of pinned) startCounts[plateIdx]++;
    for (let plateIdx = 0; plateIdx < effectiveMax.length; plateIdx++) {
      effectiveMax[plateIdx] = Math.max(effectiveMax[plateIdx], startCounts[plateIdx]);
    }
  }

  const userCandidateSets = [];
  for (const weight of weights) {
    const candidates = candidatesForWeight(weight, effectiveMax, monotonic, sided);
    if (candidates.length > 0) userCandidateSets.push(candidates);
  }

  if (userCandidateSets.length === 0) return [0, 0];
  const candidateSets = pinned ? [[pinned], ...userCandidateSets] : userCandidateSets;

  let states = new Map([['', { stack: [], cost: [0, 0] }]]);
  for (const candidates of candidateSets) {
    const nextStates = new Map();
    for (const nextStack of candidates) {
      let best = [Infinity, Infinity];
      for (const { stack: previousStack, cost } of states.values()) {
        const candidate = addPair(cost, transitionPair(previousStack, nextStack, mode, sided));
        if (lexicographicallyBetter(candidate, best)) best = candidate;
      }
      nextStates.set(nextStack.join(','), { stack: nextStack, cost: best });
    }
    states = nextStates;
  }

  let best = [Infinity, Infinity];
  for (const { stack, cost } of states.values()) {
    const candidate = addPair(cost, transitionPair(stack, [], mode, sided));
    if (lexicographicallyBetter(candidate, best)) best = candidate;
  }
  return best;
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
    { weights: [35, 45], startStack: [3, 4], monotonic: true },
    { weights: [60, 61, 80], stock: 2 },
    { weights: [61, 60, 80, 61], stock: 2 },
  ];
  for (const testCase of cases) checkAgainstOracle(testCase);
});

test('deterministic random small-domain cases match the exhaustive oracle', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const twoSidedWeights = [20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 20.5];
  const oneSidedWeights = [20, 21.25, 22.5, 25, 27.5, 30, 35, 40, 45, 50, 20.5];
  const startStacks = [null, [1], [3, 4], [4, 3], [5, 6]];

  for (let caseIndex = 0; caseIndex < 80; caseIndex++) {
    const sided = random() < 0.35 ? 1 : 2;
    const source = sided === 1 ? oneSidedWeights : twoSidedWeights;
    const length = 1 + Math.floor(random() * 5);
    const weights = Array.from({ length }, () => source[Math.floor(random() * source.length)]);
    const monotonic = random() < 0.4;
    const eligibleStartStacks = monotonic
      ? [null, [1], [3, 4], [5, 6]]
      : startStacks;
    checkAgainstOracle({
      weights,
      stock: random() < 0.25 ? 2 : 1,
      startStack: eligibleStartStacks[Math.floor(random() * eligibleStartStacks.length)],
      monotonic,
      sided,
    });
  }
});

test('invalid entries stay visible but do not force an unload boundary', () => {
  const plateMax = PLATES.map(() => 2);
  const bridged = algo.optimize([60, 61, 80], 'count', plateMax, PLATES, BAR, null, false, 2);
  const filtered = algo.optimize([60, 80], 'count', plateMax, PLATES, BAR, null, false, 2);

  assert.equal(bridged[1].valid, false);
  assert.match(bridged[1].reason, /available plate denominations/);
  assert.deepEqual(resultObjective(bridged, 'count'), resultObjective(filtered, 'count'));
  assert.deepEqual(resultObjective(bridged, 'count'), [8, 120]);
  assert.equal(bridged[0].cleanup, undefined);
  assert.ok(bridged[2].cleanup);
});

test('a pinned start is omitted when every requested set is invalid', () => {
  const plateMax = PLATES.map(() => 2);
  const results = algo.optimize([61], 'count', plateMax, PLATES, BAR, [1], false, 2);

  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].total, 61);
  assert.equal(results.some((result) => result.cleanup), false);
  assert.deepEqual(
    algo.optimize([], 'count', plateMax, PLATES, BAR, [1], false, 2),
    [],
  );
});

test('denomination failures are distinct from selected-stock failures', () => {
  const plateMax = PLATES.map(() => 1);
  const twoSided = algo.optimize([15, 20.5, 22.5, 500], 'count', plateMax, PLATES, BAR, null, false, 2);

  assert.match(twoSided[0].reason, /Below bar weight/);
  assert.match(twoSided[1].reason, /2\.5 kg total increments/);
  assert.equal(twoSided[2].valid, true);
  assert.match(twoSided[3].reason, /current stock/);

  const oneSided = algo.optimize([20.5, 21.25], 'count', plateMax, PLATES, BAR, null, false, 1);
  assert.match(oneSided[0].reason, /1\.25 kg total increments/);
  assert.equal(oneSided[1].valid, true);
});

test('the square-root objective favours fewer larger plates as documented', () => {
  const plateMax = PLATES.map(() => 2);
  const kg = algo.optimize([22.5, 30], 'kg', plateMax, PLATES, BAR, null, false, 2);
  const sqrt = algo.optimize([22.5, 30], 'sqrt', plateMax, PLATES, BAR, null, false, 2);

  assert.deepEqual(kg[1].stack, [6, 5, 6]);
  assert.deepEqual(sqrt[1].stack, [4]);
  assert.ok(resultObjective(kg, 'kg')[0] < resultObjective(sqrt, 'kg')[0]);
  assert.ok(resultObjective(sqrt, 'sqrt')[0] < resultObjective(kg, 'sqrt')[0]);
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

test('mixed-radix state encoding remains exact beyond fifteen plates of one type', () => {
  const results = algo.optimize(
    [18.75, 20],
    'count',
    [20],
    [1.25],
    0,
    null,
    false,
    1,
  );
  assert.equal(results[0].stack.length, 15);
  assert.equal(results[1].stack.length, 16);
  assert.equal(results[1].addedCount, 1);
  assert.equal(results[1].cleanup.bothSidesMoves, 16);
});

test('monotonic direct-API inputs must be ordered heaviest to lightest', () => {
  assert.throws(
    () => algo.optimize([25], 'count', [2, 2], [1.25, 2.5], 20, null, true, 2),
    /ordered heaviest to lightest/,
  );
});

test('monotonic starting stacks are validated without being reordered', () => {
  const start = [4, 3];
  assert.throws(
    () => algo.optimize([40], 'count', PLATES.map(() => 2), PLATES, BAR, start, true, 2),
    /starting stack must be ordered heaviest to lightest/,
  );
  assert.deepEqual(start, [4, 3]);
});

test('inventory irrelevant to every valid target is removed without changing exactness', () => {
  const hugeStock = PLATES.map(() => 1_000_000_000);
  const results = algo.optimize(
    [22.5, 1_000_000_000.1],
    'count',
    hugeStock,
    PLATES,
    BAR,
    null,
    false,
    2,
  );

  assert.equal(results[0].valid, true);
  assert.deepEqual(results[0].stack, [6]);
  assert.equal(results[1].valid, false);
  assert.match(results[1].reason, /available plate denominations/);
});

test('worker-facing result objects omit derivable and unused payload fields', () => {
  const results = algo.optimize([60, 80], 'count', PLATES.map(() => 2), PLATES, BAR, null, false, 2);
  for (const result of results.filter((entry) => entry.valid)) {
    for (const unused of [
      'counts', 'removedIdx', 'addedIdx', 'perSide', 'perSideMoves', 'isEnd', 'isStart',
    ]) assert.equal(unused in result, false, unused);
    assert.equal(Number.isInteger(result.removedCount), true);
    assert.equal(Number.isInteger(result.addedCount), true);
  }
  assert.equal('removedIdx' in results.at(-1).cleanup, false);
  assert.equal('removedCount' in results.at(-1).cleanup, false);
});
