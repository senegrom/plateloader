'use strict';

// Pure input, URL-state and presentation-math helpers shared by the app and tests.
function buildStateLib() {
  const KNOWN_KEYS = new Set(['w', 'm', 's', 'b', 'i', 'o', 'x', 'c']);
  const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function gcd(a, b) {
    a = Math.abs(Math.trunc(a));
    b = Math.abs(Math.trunc(b));
    while (b) [a, b] = [b, a % b];
    return a;
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number(value);
    const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : min;
    const finite = Number.isFinite(parsed) ? parsed : fallbackNumber;
    return Math.max(min, Math.min(max, Math.trunc(finite)));
  }

  function plateKg(plate) {
    return Number(typeof plate === 'number' ? plate : plate && plate.kg);
  }

  // The optimiser represents weights in quarter-kilogram units. Derive the
  // actual total-weight lattice from the available denominations rather than
  // assuming theoretical 0.25 kg plates exist.
  function totalIncrement(plates, sided = 2) {
    const sideCount = sided === 1 ? 1 : 2;
    const units = (Array.isArray(plates) ? plates : [])
      .map((plate) => Math.round(plateKg(plate) * 4))
      .filter((unit) => Number.isInteger(unit) && unit > 0);
    if (units.length === 0) return sideCount * 1.25;
    const unitGcd = units.reduce((result, unit) => gcd(result, unit));
    return Number(((unitGcd * sideCount) / 4).toFixed(6));
  }

  function describeBar(stack, plates, bar, oneSided) {
    const safeStack = Array.isArray(stack) ? stack : [];
    if (safeStack.length === 0) return `${bar} kg bar only`;
    const orderedPlates = safeStack
      .map((plateIdx) => `${plates[plateIdx].label} kg`)
      .join(', ');
    const scope = oneSided ? 'loaded side' : 'each side';
    return `${bar} kg bar; ${scope}, from collar outward: ${orderedPlates}`;
  }

  function generateWarmup(targetKg, options = {}) {
    const bar = Number.isFinite(options.bar) && options.bar >= 0 ? options.bar : 20;
    const sided = options.sided === 1 ? 1 : 2;
    const increment = totalIncrement(options.plates, sided);
    const minimum = bar > 0 ? bar : increment;
    const percentages = Array.isArray(options.percentages)
      ? options.percentages
      : [0.50, 0.70, 0.85, 0.95, 1.00];
    const seen = new Set();
    const weights = [];

    for (const percentage of percentages) {
      let weight = Math.round((targetKg * percentage) / increment) * increment;
      weight = Number(weight.toFixed(6));
      if (weight < minimum) weight = minimum;
      if (!seen.has(weight)) {
        seen.add(weight);
        weights.push(weight);
      }
    }
    return weights;
  }

  function parseWeightInput(text, options = {}) {
    const maxSets = Number.isInteger(options.maxSets) && options.maxSets > 0
      ? options.maxSets : 50;
    const maxKg = Number.isFinite(options.maxKg) && options.maxKg >= 0
      ? options.maxKg : 1000;
    const tokens = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
    const errors = [];
    const weights = [];

    if (tokens.length > maxSets) {
      errors.push(`Enter no more than ${maxSets} sets (found ${tokens.length}).`);
    }

    for (const token of tokens.slice(0, maxSets)) {
      const display = token.length > 40 ? token.slice(0, 37) + '…' : token;
      if (!DECIMAL.test(token)) {
        errors.push(`“${display}” is not a decimal weight.`);
        continue;
      }
      const weight = Number(token);
      if (!Number.isFinite(weight) || weight < 0 || weight > maxKg) {
        errors.push(`“${display}” must be between 0 and ${maxKg} kg.`);
        continue;
      }
      weights.push(weight);
    }

    return { weights, errors, tokenCount: tokens.length };
  }

  function parseHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;

    const out = {};
    for (const pair of raw.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      try { out[key] = decodeURIComponent(pair.slice(eq + 1)); } catch (_) {}
    }

    return Object.keys(out).some((key) => KNOWN_KEYS.has(key)) ? out : null;
  }

  // URL state is complete, not an overlay on saved browser state. Fields that
  // are absent from the hash deliberately resolve to the supplied defaults.
  function stateFromHash(hashOrParams, defaults) {
    const params = typeof hashOrParams === 'string'
      ? parseHash(hashOrParams)
      : hashOrParams;
    if (!params) return null;

    const state = {
      input: typeof defaults.input === 'string' ? defaults.input : '',
      mode: defaults.mode,
      stock: defaults.stock,
      bar: defaults.bar,
      startStack: null,
      monotonic: false,
      oneSided: false,
      compact: false,
    };

    if (hasOwn(params, 'w')) {
      // Preserve the sender's textarea exactly (apart from normalising CRLF).
      // Legacy comma-separated links still work because the input parser treats
      // commas as separators without rewriting what the user sees.
      state.input = String(params.w).replace(/\r\n?/g, '\n');
    }
    if (['count', 'kg', 'sqrt'].includes(params.m)) state.mode = params.m;
    if (hasOwn(params, 's') && DECIMAL.test(params.s)) {
      const stock = Number(params.s);
      if (Number.isInteger(stock) && stock >= 0) state.stock = stock;
    }
    if (hasOwn(params, 'b') && DECIMAL.test(params.b)) {
      const bar = Number(params.b);
      if (Number.isFinite(bar) && bar >= 0) state.bar = bar;
    }
    if (params.i) {
      const parts = params.i.split('.');
      if (parts.every((value) => /^\d+$/.test(value))) {
        state.startStack = parts.map(Number);
      }
    }
    state.monotonic = params.o === '1';
    state.oneSided = params.x === '1';
    state.compact = params.c === '1';

    return state;
  }

  return {
    clampInteger,
    describeBar,
    generateWarmup,
    parseWeightInput,
    parseHash,
    stateFromHash,
    totalIncrement,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildStateLib };
}
