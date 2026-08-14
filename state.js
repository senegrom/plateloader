'use strict';

// Pure input, URL-state and presentation-math helpers shared by the app and tests.
function buildStateLib() {
  const KNOWN_KEYS = new Set(['w', 'm', 's', 'b', 'i', 'o', 'x', 'c', 'p']);
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

  function parseStockVector(value, length = 7, maximum = 6) {
    const parts = Array.isArray(value) ? value : String(value ?? '').split('.');
    if (parts.length !== length) return null;

    const stock = [];
    for (const count of parts) {
      let number;
      if (typeof count === 'number') {
        number = count;
      } else if (typeof count === 'string' && /^\d+$/.test(count)) {
        number = Number(count);
      } else {
        return null;
      }
      if (!Number.isInteger(number) || number < 0 || number > maximum) return null;
      stock.push(number);
    }
    return stock;
  }

  // URL encoders reject lone UTF-16 surrogates. Normalise crafted browser
  // state to valid Unicode and avoid cutting a surrogate pair at the limit.
  function normaliseSharedText(value, maximum = Infinity) {
    const source = String(value ?? '');
    const limit = Number.isInteger(maximum) && maximum >= 0 ? maximum : Infinity;
    let output = '';
    let length = 0;

    for (let index = 0; index < source.length && length < limit; index++) {
      const code = source.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = source.charCodeAt(index + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          if (length + 2 > limit) break;
          output += source[index] + source[index + 1];
          index++;
          length += 2;
          continue;
        }
        output += '\uFFFD';
        length++;
        continue;
      }
      if (code >= 0xDC00 && code <= 0xDFFF) {
        output += '\uFFFD';
        length++;
        continue;
      }
      output += source[index];
      length++;
    }
    return output;
  }

  function plateKg(plate) {
    return Number(typeof plate === 'number' ? plate : plate && plate.kg);
  }

  function quarterUnits(plate) {
    const exact = plateKg(plate) * 4;
    const rounded = Math.round(exact);
    return Number.isFinite(exact) && rounded > 0 && Math.abs(exact - rounded) <= 1e-6
      ? rounded : 0;
  }

  // Derive the actual total-weight lattice from the available denominations
  // rather than assuming theoretical 0.25 kg plates exist.
  function totalIncrement(plates, sided = 2, maxima = null) {
    const sideCount = sided === 1 ? 1 : 2;
    const safePlates = Array.isArray(plates) ? plates : [];
    const stock = Array.isArray(maxima) ? normaliseStock(safePlates, maxima) : null;
    const units = safePlates
      .map(quarterUnits)
      .filter((unit, index) => unit > 0 && (!stock || stock[index] > 0));
    if (units.length === 0) return stock ? 0 : sideCount * 1.25;
    const unitGcd = units.reduce((result, unit) => gcd(result, unit));
    return Number(((unitGcd * sideCount) / 4).toFixed(6));
  }

  function normaliseStock(plates, maxima) {
    const length = Array.isArray(plates) ? plates.length : 0;
    return Array.from({ length }, (_, index) => {
      const count = Number(Array.isArray(maxima) ? maxima[index] : 0);
      return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    });
  }

  function reachableProfile(plates, maxima) {
    const safePlates = Array.isArray(plates) ? plates : [];
    const stock = normaliseStock(safePlates, maxima);
    const units = safePlates.map(quarterUnits);
    const maximum = units.reduce((sum, unit, index) => sum + unit * stock[index], 0);
    const reachable = new Uint8Array(maximum + 1);
    reachable[0] = 1;

    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      if (unit <= 0) continue;
      for (let copy = 0; copy < stock[index]; copy++) {
        for (let total = maximum - unit; total >= 0; total--) {
          if (reachable[total]) reachable[total + unit] = 1;
        }
      }
    }
    return { maximum, reachable };
  }

  function normaliseBar(bar) {
    const value = Number(bar);
    return Number.isFinite(value) && value >= 0 ? value : 20;
  }

  function isMonotonicStack(stack) {
    if (!Array.isArray(stack)) return true;
    for (let index = 0; index < stack.length; index++) {
      if (!Number.isInteger(stack[index]) || stack[index] < 0) return false;
      if (index > 0 && stack[index] < stack[index - 1]) return false;
    }
    return true;
  }

  function minTotalWeight(plates, maxima, bar = 20, sided = 2) {
    const safeBar = normaliseBar(bar);
    if (safeBar > 0) return safeBar;

    const sideCount = sided === 1 ? 1 : 2;
    const profile = reachableProfile(plates, maxima);
    for (let units = 1; units <= profile.maximum; units++) {
      if (profile.reachable[units]) {
        return Number((units * sideCount / 4).toFixed(6));
      }
    }
    return Infinity;
  }

  function maxTotalWeight(plates, maxima, bar = 20, sided = 2, ceiling = Infinity) {
    const safeBar = normaliseBar(bar);
    const sideCount = sided === 1 ? 1 : 2;
    const profile = reachableProfile(plates, maxima);
    const numericCeiling = Number(ceiling);
    let maximumUnits = profile.maximum;

    if (Number.isFinite(numericCeiling)) {
      if (numericCeiling < safeBar) return -Infinity;
      maximumUnits = Math.min(
        maximumUnits,
        Math.floor((numericCeiling - safeBar) * 4 / sideCount + 1e-6),
      );
      while (maximumUnits >= 0 && !profile.reachable[maximumUnits]) maximumUnits--;
      if (maximumUnits < 0) return -Infinity;
    }

    return Number((safeBar + sideCount * maximumUnits / 4).toFixed(6));
  }

  function isAchievableTotal(total, options = {}) {
    const bar = normaliseBar(options.bar);
    const sideCount = options.sided === 1 ? 1 : 2;
    const value = Number(total);
    if (!Number.isFinite(value) || value < bar) return false;

    const exactUnits = (value - bar) * 4 / sideCount;
    const targetUnits = Math.round(exactUnits);
    if (Math.abs(exactUnits - targetUnits) > 1e-6) return false;
    const profile = reachableProfile(options.plates, options.maxima);
    return targetUnits <= profile.maximum && profile.reachable[targetUnits] === 1;
  }

  function describeBar(stack, plates, bar, oneSided) {
    const safeStack = Array.isArray(stack) ? stack : [];
    const safeBar = Number(bar);
    if (safeStack.length === 0) {
      return safeBar === 0 ? 'No plates; 0 kg total' : `${safeBar} kg bar only`;
    }
    const orderedPlates = safeStack
      .map((plateIdx) => `${plates[plateIdx].label} kg`)
      .join(', ');
    const base = safeBar === 0 ? 'No bar weight' : `${safeBar} kg bar`;
    const scope = oneSided ? 'loaded side' : 'each side';
    return `${base}; ${scope}, from collar outward: ${orderedPlates}`;
  }

  function generateWarmup(targetKg, options = {}) {
    const bar = normaliseBar(options.bar);
    const sided = options.sided === 1 ? 1 : 2;
    const percentages = Array.isArray(options.percentages)
      ? options.percentages
      : [0.50, 0.70, 0.85, 0.95, 1.00];
    const target = Number(targetKg);
    if (!Number.isFinite(target) || target <= 0 || target < bar) return [];

    // Callers without stock information mean unlimited stock, not merely the
    // denomination GCD. Derive finite caps from the requested target and reuse
    // the exact bounded-reachability path so low, non-representable lattice
    // points are never emitted.
    if (!Array.isArray(options.maxima)) {
      const exactTargetUnits = (target - bar) * 4 / sided;
      const targetUnits = Math.round(exactTargetUnits);
      if (Math.abs(exactTargetUnits - targetUnits) > 1e-6) return [];
      const unlimitedMaxima = (Array.isArray(options.plates) ? options.plates : [])
        .map(quarterUnits)
        .map((unit) => unit > 0 ? Math.floor(targetUnits / unit) : 0);
      return generateWarmup(target, {
        ...options,
        maxima: unlimitedMaxima,
        percentages,
      });
    }

    const profile = reachableProfile(options.plates, options.maxima);
    const exactTargetUnits = (target - bar) * 4 / sided;
    const targetUnits = Math.round(exactTargetUnits);
    if (
      Math.abs(exactTargetUnits - targetUnits) > 1e-6 ||
      targetUnits > profile.maximum ||
      !profile.reachable[targetUnits]
    ) return [];

    const minimumUnits = bar === 0
      ? profile.reachable.findIndex((reachable, units) => units > 0 && reachable)
      : 0;
    const reachableAtOrBelow = (desiredUnits) => {
      if (minimumUnits < 0) return null;
      const upper = Math.min(targetUnits, Math.floor(desiredUnits + 1e-9));
      for (let units = upper; units >= minimumUnits; units--) {
        if (profile.reachable[units]) return units;
      }
      return null;
    };

    const seen = new Set();
    const weights = [];
    for (const rawPercentage of percentages) {
      const percentage = Number(rawPercentage);
      if (!Number.isFinite(percentage)) continue;
      const desired = (target * percentage - bar) * 4 / sided;
      const perSideUnits = reachableAtOrBelow(desired);
      if (perSideUnits === null) continue;
      const weight = Number((bar + perSideUnits * sided / 4).toFixed(6));
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
    const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars : Infinity;
    const source = String(text ?? '');
    if (source.length > maxChars) {
      return {
        weights: [],
        errors: [`Enter no more than ${maxChars} characters (found ${source.length}).`],
        tokenCount: 0,
      };
    }
    const tokens = source.split(/[\s,;]+/).filter(Boolean);
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

    const out = Object.create(null);
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
      customStock: null,
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
    if (hasOwn(params, 'p')) state.customStock = parseStockVector(params.p);

    return state;
  }

  return {
    clampInteger,
    describeBar,
    generateWarmup,
    isAchievableTotal,
    isMonotonicStack,
    maxTotalWeight,
    minTotalWeight,
    normaliseSharedText,
    parseWeightInput,
    parseStockVector,
    parseHash,
    stateFromHash,
    totalIncrement,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildStateLib };
}
