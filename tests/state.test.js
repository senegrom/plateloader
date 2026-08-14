'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStateLib } = require('../state.js');

const state = buildStateLib();
const defaults = Object.freeze({
  input: '',
  mode: 'count',
  stock: 2,
  bar: 20,
  startStack: null,
  monotonic: false,
  oneSided: false,
  compact: false,
  customStock: null,
});
const plates = [
  { kg: 25, label: '25' },
  { kg: 20, label: '20' },
  { kg: 15, label: '15' },
  { kg: 10, label: '10' },
  { kg: 5, label: '5' },
  { kg: 2.5, label: '2.5' },
  { kg: 1.25, label: '1.25' },
];

test('weight input accepts decimals and every documented separator', () => {
  assert.deepEqual(
    state.parseWeightInput('0  .25,20.; 37.5\n100', { maxSets: 10, maxKg: 1000 }),
    { weights: [0, 0.25, 20, 37.5, 100], errors: [], tokenCount: 5 },
  );
});

test('malformed and out-of-range weights are reported instead of dropped silently', () => {
  const parsed = state.parseWeightInput('60 1e2 0x20 nope -5 1001', {
    maxSets: 10,
    maxKg: 1000,
  });
  assert.deepEqual(parsed.weights, [60]);
  assert.equal(parsed.tokenCount, 6);
  assert.equal(parsed.errors.length, 5);
  assert.match(parsed.errors[0], /1e2/);
  assert.match(parsed.errors.at(-1), /1001/);
});

test('set limits are explicit', () => {
  const parsed = state.parseWeightInput('10 20 30 40', { maxSets: 3, maxKg: 1000 });
  assert.deepEqual(parsed.weights, [10, 20, 30]);
  assert.deepEqual(parsed.errors, ['Enter no more than 3 sets (found 4).']);
});

test('shared textarea input round-trips commas and malformed text exactly', () => {
  const input = 'abc,def; 60 80\r\n100';
  const restored = state.stateFromHash(`#w=${encodeURIComponent(input)}&m=kg`, defaults);
  assert.equal(restored.input, 'abc,def; 60 80\n100');
  assert.equal(restored.mode, 'kg');
  assert.deepEqual(
    state.parseWeightInput(restored.input, { maxSets: 50, maxKg: 1000 }).weights,
    [60, 80, 100],
  );
});

test('legacy comma-separated links remain usable without display rewriting', () => {
  const restored = state.stateFromHash('#w=60,80,100', defaults);
  assert.equal(restored.input, '60,80,100');
  assert.deepEqual(
    state.parseWeightInput(restored.input, { maxSets: 50, maxKg: 1000 }).weights,
    [60, 80, 100],
  );
});

test('partial hashes resolve omitted fields to defaults instead of saved state', () => {
  assert.deepEqual(state.stateFromHash('#w=100,120', defaults), {
    input: '100,120',
    mode: 'count',
    stock: 2,
    bar: 20,
    startStack: null,
    monotonic: false,
    oneSided: false,
    compact: false,
    customStock: null,
  });
});


test('input character limits bound crafted values before tokenisation', () => {
  const parsed = state.parseWeightInput('123456789', {
    maxSets: 50,
    maxKg: 1000,
    maxChars: 8,
  });
  assert.deepEqual(parsed.weights, []);
  assert.equal(parsed.tokenCount, 0);
  assert.deepEqual(parsed.errors, ['Enter no more than 8 characters (found 9).']);
});

test('custom stock vectors are exact, bounded and shareable', () => {
  assert.deepEqual(state.parseStockVector('0.1.2.3.4.5.6'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(state.parseStockVector([6, 5, 4, 3, 2, 1, 0]), [6, 5, 4, 3, 2, 1, 0]);
  assert.equal(state.parseStockVector('0.1.2'), null);
  assert.equal(state.parseStockVector('0.1.2.3.4.5.7'), null);
  assert.equal(state.parseStockVector('0.1.2.3.4.5.x'), null);
  assert.equal(state.parseStockVector('0.1.2.3.4.5.'), null);

  assert.deepEqual(
    state.stateFromHash('#w=60&p=0.1.2.3.4.5.6', defaults).customStock,
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(state.stateFromHash('#w=60&p=0.1.bad', defaults).customStock, null);
});

test('integer clamping never uses signed 32-bit coercion', () => {
  assert.equal(state.clampInteger(2147483648, 0, 6, 2), 6);
  assert.equal(state.clampInteger('5.9', 0, 6, 2), 5);
  assert.equal(state.clampInteger(-10, 0, 6, 2), 0);
  assert.equal(state.clampInteger(Infinity, 0, 6, 2), 2);
  assert.equal(state.clampInteger('not-a-number', 0, 6, 2), 2);
});

test('monotonic stack validation preserves the declared physical order', () => {
  assert.equal(state.isMonotonicStack(null), true);
  assert.equal(state.isMonotonicStack([]), true);
  assert.equal(state.isMonotonicStack([1, 1, 4, 6]), true);
  assert.equal(state.isMonotonicStack([4, 3]), false);
  assert.equal(state.isMonotonicStack([1, -1]), false);
});

test('bar descriptions preserve plate order and describe a zero-weight bar honestly', () => {
  assert.equal(
    state.describeBar([1, 4, 1], plates, 20, false),
    '20 kg bar; each side, from collar outward: 20 kg, 5 kg, 20 kg',
  );
  assert.equal(
    state.describeBar([1, 1, 4], plates, 20, false),
    '20 kg bar; each side, from collar outward: 20 kg, 20 kg, 5 kg',
  );
  assert.equal(
    state.describeBar([6], plates, 0, true),
    'No bar weight; loaded side, from collar outward: 1.25 kg',
  );
  assert.equal(state.describeBar([], plates, 20, false), '20 kg bar only');
  assert.equal(state.describeBar([], plates, 0, false), 'No plates; 0 kg total');
});

test('the achievable total increment is derived from valid plate denominations', () => {
  assert.equal(state.totalIncrement(plates, 2), 2.5);
  assert.equal(state.totalIncrement(plates, 1), 1.25);
  assert.equal(state.totalIncrement([{ kg: 5 }, { kg: 2.5 }], 2), 5);
  assert.equal(state.totalIncrement([{ kg: 5 }, { kg: 2.5 }], 1), 2.5);
  assert.equal(state.totalIncrement([{ kg: 1.3 }, { kg: 2.5 }], 2), 5);
});

test('the displayed increment ignores denominations with no available stock', () => {
  assert.equal(state.totalIncrement(plates, 2, [1, 0, 0, 0, 0, 0, 0]), 50);
  assert.equal(state.totalIncrement(plates, 1, [1, 0, 0, 0, 0, 0, 0]), 25);
  assert.equal(state.totalIncrement(plates, 2, plates.map(() => 0)), 0);
});

test('warm-ups use the derived increment for the selected sidedness', () => {
  assert.deepEqual(
    state.generateWarmup(100, { bar: 20, sided: 2, plates }),
    [50, 70, 85, 95, 100],
  );
  assert.deepEqual(
    state.generateWarmup(42.5, { bar: 20, sided: 1, plates }),
    [21.25, 28.75, 35, 40, 42.5],
  );
});

test('stock-aware warm-ups use only loadable weights and respect true bounds', () => {
  const stockTwo = plates.map(() => 2);
  assert.equal(state.minTotalWeight(plates, stockTwo, 20, 2), 20);
  assert.equal(state.maxTotalWeight(plates, stockTwo, 20, 2), 335);
  assert.equal(state.maxTotalWeight([{ kg: 25 }], [100], 20, 2, 1000), 970);
  assert.equal(state.isAchievableTotal(100, { bar: 20, sided: 2, plates, maxima: stockTwo }), true);
  assert.equal(state.isAchievableTotal(101, { bar: 20, sided: 2, plates, maxima: stockTwo }), false);
  assert.deepEqual(
    state.generateWarmup(100, { bar: 20, sided: 2, plates, maxima: stockTwo }),
    [50, 70, 85, 95, 100],
  );

  const onlyTwentyFive = [1, 0, 0, 0, 0, 0, 0];
  assert.equal(state.minTotalWeight(plates, onlyTwentyFive, 0, 2), 50);
  assert.equal(state.maxTotalWeight(plates, onlyTwentyFive, 20, 2), 70);
  assert.equal(state.isAchievableTotal(70, {
    bar: 20, sided: 2, plates, maxima: onlyTwentyFive,
  }), true);
  assert.equal(state.isAchievableTotal(45, {
    bar: 20, sided: 2, plates, maxima: onlyTwentyFive,
  }), false);
  assert.deepEqual(
    state.generateWarmup(70, {
      bar: 20, sided: 2, plates, maxima: onlyTwentyFive,
    }),
    [20, 70],
  );
});

test('warm-up percentages never overshoot their intended load', () => {
  assert.deepEqual(
    state.generateWarmup(100, {
      bar: 20, sided: 2, plates: [{ kg: 20 }], maxima: [2],
    }),
    [20, 60, 100],
  );
});

test('invalid warm-up targets return no generated sets', () => {
  assert.deepEqual(state.generateWarmup(NaN, { bar: 20, sided: 2, plates }), []);
  assert.deepEqual(state.generateWarmup(-10, { bar: 20, sided: 2, plates }), []);
  assert.deepEqual(state.generateWarmup(10, { bar: 20, sided: 2, plates }), []);
  assert.deepEqual(state.generateWarmup(42, { bar: 20, sided: 1, plates }), []);
});

test('zero-bar warm-ups never generate a zero-weight set', () => {
  assert.deepEqual(state.generateWarmup(1, { bar: 0, sided: 2, plates }), []);
  assert.deepEqual(state.generateWarmup(2.5, { bar: 0, sided: 2, plates }), [2.5]);
  assert.deepEqual(state.generateWarmup(1.25, { bar: 0, sided: 1, plates }), [1.25]);
  assert.deepEqual(state.generateWarmup(2.5, {
    bar: 0, sided: 1, plates: [{ kg: 2.5 }], maxima: [1],
  }), [2.5]);
  assert.deepEqual(state.generateWarmup(5, {
    bar: 0, sided: 2, plates: [{ kg: 2.5 }], maxima: [1],
  }), [5]);
  assert.equal(state.minTotalWeight(plates, plates.map(() => 0), 0, 2), Infinity);
});

test('invalid anchors and malformed encoded values are ignored safely', () => {
  assert.equal(Object.getPrototypeOf(state.parseHash('#w=100')), null);
  assert.equal(state.stateFromHash('#summary', defaults), null);
  assert.equal(state.stateFromHash('#other=value', defaults), null);
  assert.equal(state.stateFromHash('#w=%E0%A4%A', defaults), null);
});
