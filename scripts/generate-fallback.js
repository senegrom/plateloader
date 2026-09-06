'use strict';

// Compile a separate cooperative runtime from the exact synchronous source.
// This is a build target, never eval/new Function in the browser. Explicit
// anchors fail closed on source drift; parity and scheduling tests cover it.
const vm = require('node:vm');
function generateFallback(source) {
  const once = (from, to) => {
    if (source.split(from).length !== 2) throw new Error(`Fallback source anchor changed: ${from.slice(0, 90)}`);
    source = source.replace(from, to);
  };
  once('function buildAlgoLib()', 'function buildFallbackAlgoLib()');
  once('module.exports = { buildAlgoLib };', 'module.exports = { buildFallbackAlgoLib };');
  once('  function optimize(', '  function* optimizeSteps(');
  const begin = source.indexOf('    let operations = 0;');
  const end = source.indexOf('    checkTime(true);', begin);
  if (begin < 0 || end < 0) throw new Error('Missing fallback clock anchors');
  source = source.slice(0, begin) + `    let operations = 0;
    const cooperative = options.cooperative;
    function checkTime(force = false) {
      if (!force && (++operations & 127) !== 0) return false;
      const now = clock();
      if (now >= deadline) {
        const error = new Error('Exact calculation exceeded its time budget.');
        error.name = 'TimeoutError';
        throw error;
      }
      return now >= cooperative.until;
    }
` + source.slice(end);
  once('    const sets = weights.map((weight, index) => {', '    function* createSet(weight, index) {');
  once('      return { invalid: false, total, targetUnits, feasibility };\n    });',
    `      return { invalid: false, total, targetUnits, feasibility };
    }
    const sets = [];
    for (let index = 0; index < weights.length; index++) sets.push(yield* createSet(weights[index], index));`);
  for (const name of ['feasibilityFor', 'enumerate', 'optimizeRun', 'block', 'computeBlock', 'optimizeRunCompact', 'solve']) {
    once(`function ${name}(`, `function* ${name}(`);
    const calls = new RegExp(`(?<!function\\* )\\b${name}\\(`, 'g');
    if (!calls.test(source)) throw new Error(`Missing fallback call site: ${name}`);
    source = source.replace(calls, `yield* ${name}(`);
  }
  source = source.replace(/\bcheckTime\((true)?\);/g, (_, force) => `if (checkTime(${force || ''})) yield;`);
  once('  return { optimize, hasPinnedStart };', `  async function optimizeAsync(weights, mode, plateMax, plates, bar, start, monotonic, sided, options = {}) {
    // Capture inputs before yielding, including nested denomination objects.
    weights = Array.isArray(weights) ? weights.slice() : weights;
    plateMax = Array.isArray(plateMax) ? plateMax.slice() : plateMax;
    plates = Array.isArray(plates) ? plates.map((p) => typeof p === 'number' ? p : { kg: p && p.kg }) : plates;
    start = Array.isArray(start) ? start.slice() : start;
    options = { ...options };
    const sliceMs = Number.isFinite(options.sliceMs) ? Math.max(1, Math.min(16, options.sliceMs)) : 8;
    const cooperative = { until: 0 };
    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const search = optimizeSteps(weights, mode, plateMax, plates, bar, start, monotonic, sided, { ...options, cooperative });
    const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await yieldTask();
      for (;;) {
        if (options.signal && options.signal.aborted) {
          const error = new Error('Calculation cancelled.'); error.name = 'AbortError'; throw error;
        }
        cooperative.until = now() + sliceMs;
        const result = search.next();
        if (result.done) return result.value;
        // Timer tasks also allow ordinary timers to run, rather than using
        // microtasks or scheduler continuations with boosted priority.
        await yieldTask();
      }
    } finally { search.return(); }
  }
  return { optimizeAsync, hasPinnedStart };`);
  source = '// Generated from algo.js by scripts/generate-fallback.js; do not edit.\n' + source;
  new vm.Script(source, { filename: 'algo-fallback.js' });
  return source;
}
module.exports = { generateFallback };
