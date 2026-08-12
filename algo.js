'use strict';

// Plate-loader optimisation algorithm. Self-contained — no DOM access,
// no runtime dependencies. Used by plateloader.js on the main thread, by
// algo-worker.js through importScripts(), and by the regression tests.
//
// Cost depends only on the MULTISET of shared prefixes, not order. We
// build optimal stacks level-by-level via a recursive DP:
//   f([a, b], P) = min cost for sets [a, b] given they all share prefix P
// At depth |P|+1 we partition into runs (consecutive sets that pick the
// same plate) plus "stop" sets (whose final multiset is exactly P). A run
// with plate p contributes 2·cost(p) + f(run, P ∪ {p}). Memoise on (a, b, P).
function buildAlgoLib() {
  'use strict';

  function optimize(weights, mode, plateMax, PLATES, BAR, startStack, monotonic, sided) {
    const NP = PLATES.length;
    // sided = 2 (default: symmetric loading on both sides) or 1 (one-sided).
    if (sided !== 1 && sided !== 2) sided = 2;

    // If a startStack is provided, prepend a pinned "starting state" set
    // whose only combo is exactly that stack — AND whose allowed prefixes
    // are only the ORDERED prefixes of startStack (not all sub-multisets).
    // This forces the DP to share plates with set 1 only when those plates
    // are at the inner end of the user's stack.
    if (startStack && startStack.length) {
      // Monotonic mode: the pinned prefix chain must itself be monotonic or
      // the DP can never reach the start state. The UI pre-sorts; enforce
      // here too so the algorithm doesn't depend on caller discipline.
      if (monotonic) startStack = startStack.slice().sort((a, b) => a - b);
      let startKg = BAR;
      const startCounts = new Array(NP).fill(0);
      for (const i of startStack) { startKg += sided * PLATES[i].kg; startCounts[i]++; }
      // Plates already on the bar physically exist even if the stock slider
      // is set lower — raise the effective per-type cap, otherwise the DP
      // can never extend the prefix up to the pinned start state and every
      // set in the run silently comes back with an empty stack.
      plateMax = plateMax.map((m, p) => Math.max(m, startCounts[p]));
      weights = [startKg, ...weights];
    }

    function findCombos(perSideKg) {
      const target = Math.round(perSideKg * 4);
      if (target < 0 || Math.abs(target - perSideKg * 4) > 1e-6) return [];
      const units = PLATES.map(p => Math.round(p.kg * 4));
      const out = [];
      const buf = new Array(NP).fill(0);
      function recurse(idx, remaining) {
        if (remaining === 0) { out.push(buf.slice()); return; }
        if (idx >= NP) return;
        const u = units[idx];
        const maxN = Math.min(plateMax[idx], Math.floor(remaining / u));
        for (let n = maxN; n >= 0; n--) {
          buf[idx] = n;
          recurse(idx + 1, remaining - n * u);
        }
        buf[idx] = 0;
      }
      recurse(0, target);
      return out;
    }

    function transition(prev, next) {
      let i = 0;
      while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
      return { removedIdx: prev.slice(i), addedIdx: next.slice(i) };
    }

    function transitionCost(prev, next) {
      const { removedIdx, addedIdx } = transition(prev, next);
      let kg = 0, sqrtKg = 0;
      for (const i of removedIdx) { const w = PLATES[i].kg; kg += w; sqrtKg += Math.sqrt(w); }
      for (const i of addedIdx)   { const w = PLATES[i].kg; kg += w; sqrtKg += Math.sqrt(w); }
      return { count: removedIdx.length + addedIdx.length, kg, sqrtKg };
    }

    // Encode a 7-element count array (each 0..15) into one int (4 bits × 7 = 28).
    const encode = (c) =>
      (c[0]<<24)|(c[1]<<20)|(c[2]<<16)|(c[3]<<12)|(c[4]<<8)|(c[5]<<4)|c[6];

    const sets = weights.map((w, idx) => {
      const total = w;
      const perSide = (total - BAR) / sided;
      const isPinned = startStack && startStack.length && idx === 0;

      if (isPinned) {
        const counts = new Array(NP).fill(0);
        for (const p of startStack) counts[p]++;
        const comboKeys = new Set([encode(counts)]);
        const prefixKeys = new Set();
        const buf = new Array(NP).fill(0);
        prefixKeys.add(encode(buf));
        for (const p of startStack) { buf[p]++; prefixKeys.add(encode(buf)); }
        return { invalid: false, total, perSide, combos: [counts.slice()], comboKeys, prefixKeys };
      }

      if (total < BAR || perSide < 0 || Math.abs(perSide * 4 - Math.round(perSide * 4)) > 1e-6) {
        return { invalid: true, total, reason: total < BAR ? `Below bar weight (${BAR} kg)` : `Not achievable in ${sided === 1 ? '0.25' : '0.5'} kg increments` };
      }
      const combos = findCombos(perSide);
      if (combos.length === 0) return { invalid: true, total, reason: 'No plate combination available with current stock' };

      // Precompute combo + sub-multiset sets for O(1) lookups in the hot loop.
      const comboKeys = new Set();
      const prefixKeys = new Set();
      const buf = new Array(NP).fill(0);
      for (const c of combos) {
        comboKeys.add(encode(c));
        (function enumSub(i) {
          if (i === NP) { prefixKeys.add(encode(buf)); return; }
          for (let n = 0; n <= c[i]; n++) { buf[i] = n; enumSub(i + 1); }
          buf[i] = 0;
        })(0);
      }
      return { invalid: false, total, perSide, combos, comboKeys, prefixKeys };
    });

    const plateCostPrimary = (idx) =>
      mode === 'count' ? 1 : mode === 'kg' ? PLATES[idx].kg : Math.sqrt(PLATES[idx].kg);
    const plateCostSecondary = (idx) => mode === 'count' ? PLATES[idx].kg : 1;

    const EPS = 1e-9;

    function optimizeRun(a, b) {
      const memo = new Map();
      const memoChoices = new Map();
      const fKey = (a, b, P) => a + '|' + b + '|' + encode(P);

      function f(a, b, P) {
        if (a > b) return [0, 0];
        const Penc = encode(P);
        const key = a + '|' + b + '|' + Penc;
        const hit = memo.get(key);
        if (hit !== undefined) return hit;

        const len = b - a + 1;
        const dp = new Array(len + 1);
        const choice = new Array(len + 1).fill(null);
        dp[0] = [0, 0];
        for (let k = 1; k <= len; k++) dp[k] = [Infinity, Infinity];

        for (let j = a; j <= b; j++) {
          const k = j - a + 1;
          const sj = sets[j];
          const dpk = dp[k];

          // Option: set j is "stop" — its multiset is exactly P.
          if (sj.comboKeys.has(Penc)) {
            const prev = dp[k - 1];
            if (prev[0] < dpk[0] - EPS || (prev[0] <= dpk[0] + EPS && prev[1] < dpk[1] - EPS)) {
              dpk[0] = prev[0]; dpk[1] = prev[1];
              choice[k] = { type: 'STOP' };
            }
          }

          // Option: a run [i, j] with plate p ends at j.
          // Monotonicity: each added plate p must have idx >= the largest idx
          // already in P (PLATES is ordered heaviest→lightest, so larger idx
          // = lighter plate; non-decreasing idx = weight non-increasing from
          // innermost out).
          let maxInP = -1;
          if (monotonic) {
            for (let q = NP - 1; q >= 0; q--) if (P[q] > 0) { maxInP = q; break; }
          }
          const Pcopy = P.slice();
          for (let p = 0; p < NP; p++) {
            if (P[p] + 1 > plateMax[p]) continue;
            if (monotonic && p < maxInP) continue;
            Pcopy[p] = P[p] + 1;
            const newKey = encode(Pcopy);
            if (!sj.prefixKeys.has(newKey)) { Pcopy[p] = P[p]; continue; }
            const stepPrim = sided * plateCostPrimary(p);
            const stepSec  = sided * plateCostSecondary(p);
            for (let i = j; i >= a; i--) {
              if (i < j && !sets[i].prefixKeys.has(newKey)) break;
              const inner = f(i, j, Pcopy);
              const prev = dp[i - a];
              const sum0 = prev[0] + stepPrim + inner[0];
              const sum1 = prev[1] + stepSec  + inner[1];
              if (sum0 < dpk[0] - EPS || (sum0 <= dpk[0] + EPS && sum1 < dpk[1] - EPS)) {
                dpk[0] = sum0; dpk[1] = sum1;
                choice[k] = { type: 'RUN', i, plate: p };
              }
            }
            Pcopy[p] = P[p];
          }
        }
        memo.set(key, dp[len]);
        memoChoices.set(key, choice);
        return dp[len];
      }

      const empty = new Array(NP).fill(0);
      f(a, b, empty);

      const stacks = {};
      for (let i = a; i <= b; i++) stacks[i] = [];
      (function backtrack(a, b, P_seq, P_counts) {
        if (a > b) return;
        const choice = memoChoices.get(fKey(a, b, P_counts));
        let j = b;
        while (j >= a) {
          const ch = choice[j - a + 1];
          if (!ch) break;
          if (ch.type === 'STOP') { stacks[j] = P_seq.slice(); j--; }
          else {
            const { i, plate } = ch;
            const newCounts = P_counts.slice(); newCounts[plate]++;
            backtrack(i, j, P_seq.concat([plate]), newCounts);
            j = i - 1;
          }
        }
      })(a, b, [], empty.slice());
      return stacks;
    }

    // Stitch each valid run's optimal stacks together.
    const out = [];
    let prevStack = [];
    let i = 0;
    while (i < sets.length) {
      if (sets[i].invalid) {
        out.push({ valid: false, total: sets[i].total, reason: sets[i].reason });
        prevStack = []; i++; continue;
      }
      let runEnd = i;
      while (runEnd + 1 < sets.length && !sets[runEnd + 1].invalid) runEnd++;
      const stacks = optimizeRun(i, runEnd);

      for (let j = i; j <= runEnd; j++) {
        const stack = stacks[j];
        const counts = new Array(NP).fill(0);
        for (const k of stack) counts[k]++;
        const startOfRun = (j === i), endOfRun = (j === runEnd);
        const fromStack = startOfRun ? [] : prevStack;
        const t = transition(fromStack, stack);
        const c = transitionCost(fromStack, stack);
        const entry = {
          valid: true,
          total: sets[j].total, perSide: sets[j].perSide,
          stack, counts,
          removedIdx: t.removedIdx, addedIdx: t.addedIdx,
          perSideMoves: c.count, bothSidesMoves: c.count * sided,
          bothSidesKg: c.kg * sided, bothSidesSqrtKg: c.sqrtKg * sided,
          isStart: startOfRun, isEnd: endOfRun,
        };
        if (endOfRun) {
          const u = transitionCost(stack, []);
          entry.cleanup = {
            removedIdx: stack.slice(),
            bothSidesMoves: u.count * sided, bothSidesKg: u.kg * sided, bothSidesSqrtKg: u.sqrtKg * sided,
          };
        }
        out.push(entry);
        prevStack = stack;
      }
      i = runEnd + 1; prevStack = [];
    }
    return out;
  }

  return { optimize };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAlgoLib };
}
