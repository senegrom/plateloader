'use strict';

// Pure input and URL-state helpers shared by the browser app and Node tests.
function buildStateLib() {
  const KNOWN_KEYS = new Set(['w', 'm', 's', 'b', 'i', 'o', 'x', 'c']);
  const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

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
      // Commas preserve compatibility with earlier links; newly generated
      // links percent-encode the raw textarea so malformed input is not lost.
      state.input = String(params.w).replace(/\r\n?/g, '\n').replace(/,/g, '\n');
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

  return { parseWeightInput, parseHash, stateFromHash };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildStateLib };
}
