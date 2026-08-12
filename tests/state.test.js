'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStateLib } = require('../state.js');

const stateLib = buildStateLib();
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

test('weight input accepts decimal values and all documented separators', () => {
  assert.deepEqual(
    stateLib.parseWeightInput('0  .25,20.; 37.5\n100', { maxSets: 10, maxKg: 1000 }),
    { weights: [0, 0.25, 20, 37.5, 100], errors: [], tokenCount: 5 },
  );
});

test('malformed and out-of-range weights are reported instead of silently dropped', () => {
  const parsed = stateLib.parseWeightInput('60 1e2 0x20 nope -5 1001', {
    maxSets: 10,
    maxKg: 1000,
  });
  assert.deepEqual(parsed.weights, [60]);
  assert.equal(parsed.tokenCount, 6);
  assert.deepEqual(parsed.errors, [
    '“1e2” is not a decimal weight.',
    '“0x20” is not a decimal weight.',
    '“nope” is not a decimal weight.',
    '“-5” must be between 0 and 1000 kg.',
    '“1001” must be between 0 and 1000 kg.',
  ]);
});

test('the set limit is explicit and no values beyond it are accepted', () => {
  const parsed = stateLib.parseWeightInput('10 20 30 40', { maxSets: 3, maxKg: 1000 });
  assert.deepEqual(parsed.weights, [10, 20, 30]);
  assert.deepEqual(parsed.errors, ['Enter no more than 3 sets (found 4).']);
  assert.equal(parsed.tokenCount, 4);
});

test('a partial share hash resolves every omitted field to defaults', () => {
  const state = stateLib.stateFromHash('#w=100,120', defaults);
  assert.deepEqual(state, {
    input: '100\n120',
    mode: 'count',
    stock: 2,
    bar: 20,
    startStack: null,
    monotonic: false,
    oneSided: false,
    compact: false,
  });
});

test('new share links preserve multiline and malformed textarea content', () => {
  const input = '60\nnot-a-weight; 80 & 100';
  const state = stateLib.stateFromHash(`#w=${encodeURIComponent(input)}&m=kg`, defaults);
  assert.equal(state.input, input);
  assert.equal(state.mode, 'kg');
});

test('all supported hash fields decode without inheriting previous state', () => {
  const state = stateLib.stateFromHash(
    '#w=60%2C80&m=sqrt&s=5&b=15&i=1.4.1&o=1&x=1&c=1',
    defaults,
  );
  assert.deepEqual(state, {
    input: '60\n80',
    mode: 'sqrt',
    stock: 5,
    bar: 15,
    startStack: [1, 4, 1],
    monotonic: true,
    oneSided: true,
    compact: true,
  });
});

test('malformed starting-stack values are rejected as a whole', () => {
  assert.equal(stateLib.stateFromHash('#w=100&i=1.-1.2', defaults).startStack, null);
  assert.equal(stateLib.stateFromHash('#w=100&i=1.x.2', defaults).startStack, null);
  assert.deepEqual(stateLib.stateFromHash('#w=100&i=1.0.2', defaults).startStack, [1, 0, 2]);
});

test('an explicit empty weight field is recognised as deterministic default state', () => {
  assert.deepEqual(stateLib.stateFromHash('#w=', defaults), defaults);
});

test('unknown anchors and wholly malformed encoded values are ignored', () => {
  assert.equal(stateLib.stateFromHash('#summary', defaults), null);
  assert.equal(stateLib.stateFromHash('#other=value', defaults), null);
  assert.equal(stateLib.stateFromHash('#w=%E0%A4%A', defaults), null);
});

test('invalid modes remain at the default while valid numeric values are retained', () => {
  const state = stateLib.stateFromHash('#w=100&m=turbo&s=0&b=0', defaults);
  assert.equal(state.mode, 'count');
  assert.equal(state.stock, 0);
  assert.equal(state.bar, 0);
});

test('empty, negative and non-decimal numeric hash values do not become zero', () => {
  const empty = stateLib.stateFromHash('#w=100&s=&b=', defaults);
  assert.equal(empty.stock, defaults.stock);
  assert.equal(empty.bar, defaults.bar);

  const malformed = stateLib.stateFromHash('#w=100&s=-1&b=0x14', defaults);
  assert.equal(malformed.stock, defaults.stock);
  assert.equal(malformed.bar, defaults.bar);
});
