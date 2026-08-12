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
  });
});

test('integer clamping never uses signed 32-bit coercion', () => {
  assert.equal(state.clampInteger(2147483648, 0, 6, 2), 6);
  assert.equal(state.clampInteger('5.9', 0, 6, 2), 5);
  assert.equal(state.clampInteger(-10, 0, 6, 2), 0);
  assert.equal(state.clampInteger(Infinity, 0, 6, 2), 2);
  assert.equal(state.clampInteger('not-a-number', 0, 6, 2), 2);
});

test('bar descriptions preserve plate order from the collar outward', () => {
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
    '0 kg bar; loaded side, from collar outward: 1.25 kg',
  );
  assert.equal(state.describeBar([], plates, 20, false), '20 kg bar only');
});

test('the achievable total increment is derived from plate denominations', () => {
  assert.equal(state.totalIncrement(plates, 2), 2.5);
  assert.equal(state.totalIncrement(plates, 1), 1.25);
  assert.equal(state.totalIncrement([{ kg: 5 }, { kg: 2.5 }], 2), 5);
  assert.equal(state.totalIncrement([{ kg: 5 }, { kg: 2.5 }], 1), 2.5);
});

test('warm-ups use the derived increment for the selected sidedness', () => {
  assert.deepEqual(
    state.generateWarmup(100, { bar: 20, sided: 2, plates }),
    [50, 70, 85, 95, 100],
  );
  assert.deepEqual(
    state.generateWarmup(42, { bar: 20, sided: 1, plates }),
    [21.25, 30, 36.25, 40, 42.5],
  );
});

test('zero-bar warm-ups never generate a zero-weight set', () => {
  assert.deepEqual(state.generateWarmup(1, { bar: 0, sided: 2, plates }), [2.5]);
  assert.deepEqual(state.generateWarmup(1, { bar: 0, sided: 1, plates }), [1.25]);
});

test('invalid anchors and malformed encoded values are ignored safely', () => {
  assert.equal(state.stateFromHash('#summary', defaults), null);
  assert.equal(state.stateFromHash('#other=value', defaults), null);
  assert.equal(state.stateFromHash('#w=%E0%A4%A', defaults), null);
});
