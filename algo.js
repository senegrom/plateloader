'use strict';

// Exact plate-loader optimisation algorithm. It is self-contained, has no DOM
// access and is shared by the page, Web Worker and regression tests.
function buildAlgoLib() {
  'use strict';

  function optimize(weights, mode, plateMax, PLATES, BAR, startStack, monotonic, sided) {
    const NP = PLATES.length;
    if (sided !== 1 && sided !== 2) sided = 2;

    const plateKg = PLATES.map((plate) => Number(typeof plate === 'number' ? plate : plate.kg));
    const units = plateKg.map((kg) => Math.round(kg * 4));
    const gcd = (a, b) => {
      a = Math.abs(Math.trunc(a));
      b = Math.abs(Math.trunc(b));
      while (b) [a, b] = [b, a % b];
      return a;
    };
    const denominationUnits = units.reduce((result, unit) => gcd(result, unit), 0) || 1;
    const totalIncrementUnits = denominationUnits * sided;
    const totalIncrementKg = totalIncrementUnits / 4;
    const formatKg = (value) => String(Number(value.toFixed(6)));

    // A pinned starting stack is a real physical state even when its counts
    // exceed the selected stock slider. Raise the effective caps accordingly.
    if (startStack && startStack.length) {
      if (monotonic) startStack = startStack.slice().sort((a, b) => a - b);
      let startKg = BAR;
      const startCounts = new Array(NP).fill(0);
      for (const plateIndex of startStack) {
        startKg += sided * plateKg[plateIndex];
        startCounts[plateIndex]++;
      }
      plateMax = plateMax.map((maximum, plateIndex) =>
        Math.max(maximum, startCounts[plateIndex]));
      weights = [startKg, ...weights];
    }

    // Counts are encoded as seven hexadecimal nibbles. UI limits keep every
    // count below 16, so the result fits comfortably inside 28 bits.
    const encode = (counts) => {
      let value = 0;
      for (let index = 0; index < NP; index++) value = value * 16 + counts[index];
      return value;
    };

    const feasibilityCache = new Map();
    function feasibilityFor(targetUnits) {
      const cached = feasibilityCache.get(targetUnits);
      if (cached) return cached;

      const comboKeys = new Set();
      const prefixKeys = new Set();
      const counts = new Array(NP).fill(0);
      const prefix = new Array(NP).fill(0);

      function addPrefixes(index) {
        if (index === NP) {
          prefixKeys.add(encode(prefix));
          return;
        }
        for (let count = 0; count <= counts[index]; count++) {
          prefix[index] = count;
          addPrefixes(index + 1);
        }
        prefix[index] = 0;
      }

      function enumerate(index, remaining) {
        if (remaining === 0) {
          comboKeys.add(encode(counts));
          addPrefixes(0);
          return;
        }
        if (index >= NP) return;
        const unit = units[index];
        const maximum = Math.min(plateMax[index], Math.floor(remaining / unit));
        for (let count = maximum; count >= 0; count--) {
          counts[index] = count;
          enumerate(index + 1, remaining - count * unit);
        }
        counts[index] = 0;
      }

      enumerate(0, targetUnits);
      const feasibility = { comboKeys, prefixKeys };
      feasibilityCache.set(targetUnits, feasibility);
      return feasibility;
    }

    const sets = weights.map((weight, index) => {
      const total = Number(weight);
      const isPinned = Boolean(startStack && startStack.length && index === 0);

      if (isPinned) {
        const counts = new Array(NP).fill(0);
        for (const plateIndex of startStack) counts[plateIndex]++;
        const comboKeys = new Set([encode(counts)]);
        const prefixKeys = new Set();
        const prefix = new Array(NP).fill(0);
        prefixKeys.add(encode(prefix));
        for (const plateIndex of startStack) {
          prefix[plateIndex]++;
          prefixKeys.add(encode(prefix));
        }
        return { invalid: false, total, feasibility: { comboKeys, prefixKeys } };
      }

      if (!Number.isFinite(total) || total < BAR) {
        return {
          invalid: true,
          total,
          reason: Number.isFinite(total)
            ? `Below bar weight (${BAR} kg)`
            : 'Weight is not finite',
        };
      }

      const exactTotalUnits = (total - BAR) * 4;
      const roundedTotalUnits = Math.round(exactTotalUnits);
      if (
        Math.abs(exactTotalUnits - roundedTotalUnits) > 1e-6 ||
        roundedTotalUnits % totalIncrementUnits !== 0
      ) {
        return {
          invalid: true,
          total,
          reason: `Not achievable with available plate denominations (requires ${formatKg(totalIncrementKg)} kg total increments)`,
        };
      }

      const targetUnits = roundedTotalUnits / sided;
      const feasibility = feasibilityFor(targetUnits);
      if (feasibility.comboKeys.size === 0) {
        return {
          invalid: true,
          total,
          reason: 'No plate combination available with current stock',
        };
      }
      return { invalid: false, total, feasibility };
    });

    // Invalid user entries are display annotations, not physical bar states.
    // Optimise all valid entries together, then reinsert invalid rows in their
    // original positions without forcing an unload/reload boundary.
    const activeSets = [];
    const activeIndexByOriginal = new Map();
    for (let originalIndex = 0; originalIndex < sets.length; originalIndex++) {
      if (sets[originalIndex].invalid) continue;
      activeIndexByOriginal.set(originalIndex, activeSets.length);
      activeSets.push(sets[originalIndex]);
    }

    if (activeSets.length === 0) {
      return sets.map((set) => ({
        valid: false,
        skipped: true,
        total: set.total,
        reason: set.reason,
      }));
    }

    const plateCostPrimary = (plateIndex) =>
      mode === 'count' ? 1 : mode === 'kg' ? plateKg[plateIndex] : Math.sqrt(plateKg[plateIndex]);
    const plateCostSecondary = (plateIndex) => mode === 'count' ? plateKg[plateIndex] : 1;
    const EPSILON = 1e-9;
    const INTERVAL_BASE = 64;
    const PREFIX_BASE = INTERVAL_BASE * INTERVAL_BASE;
    const packMemoKey = (start, end, prefixKey) =>
      prefixKey * PREFIX_BASE + start * INTERVAL_BASE + end;

    function optimizeRun() {
      const memo = new Map();

      function solve(start, end, prefixCounts) {
        if (start > end) return { primary: 0, secondary: 0, choice: null };
        const prefixKey = encode(prefixCounts);
        const memoKey = packMemoKey(start, end, prefixKey);
        const cached = memo.get(memoKey);
        if (cached) return cached;

        const length = end - start + 1;
        const primary = new Float64Array(length + 1);
        const secondary = new Float64Array(length + 1);
        primary.fill(Infinity);
        secondary.fill(Infinity);
        primary[0] = 0;
        secondary[0] = 0;
        const choices = new Array(length + 1).fill(null);

        let largestPlateIndex = -1;
        if (monotonic) {
          for (let index = NP - 1; index >= 0; index--) {
            if (prefixCounts[index] > 0) {
              largestPlateIndex = index;
              break;
            }
          }
        }

        const extensions = [];
        for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
          if (prefixCounts[plateIndex] + 1 > plateMax[plateIndex]) continue;
          if (monotonic && plateIndex < largestPlateIndex) continue;
          const counts = prefixCounts.slice();
          counts[plateIndex]++;
          extensions.push({
            plateIndex,
            counts,
            key: encode(counts),
            primary: sided * plateCostPrimary(plateIndex),
            secondary: sided * plateCostSecondary(plateIndex),
          });
        }

        for (let setIndex = start; setIndex <= end; setIndex++) {
          const offset = setIndex - start + 1;
          const set = activeSets[setIndex];

          if (set.feasibility.comboKeys.has(prefixKey)) {
            const previousPrimary = primary[offset - 1];
            const previousSecondary = secondary[offset - 1];
            if (
              previousPrimary < primary[offset] - EPSILON ||
              (previousPrimary <= primary[offset] + EPSILON &&
                previousSecondary < secondary[offset] - EPSILON)
            ) {
              primary[offset] = previousPrimary;
              secondary[offset] = previousSecondary;
              choices[offset] = { type: 'STOP' };
            }
          }

          for (const extension of extensions) {
            if (!set.feasibility.prefixKeys.has(extension.key)) continue;
            for (let runStart = setIndex; runStart >= start; runStart--) {
              if (
                runStart < setIndex &&
                !activeSets[runStart].feasibility.prefixKeys.has(extension.key)
              ) break;

              const inner = solve(runStart, setIndex, extension.counts);
              const previousOffset = runStart - start;
              const candidatePrimary =
                primary[previousOffset] + extension.primary + inner.primary;
              const candidateSecondary =
                secondary[previousOffset] + extension.secondary + inner.secondary;

              if (
                candidatePrimary < primary[offset] - EPSILON ||
                (candidatePrimary <= primary[offset] + EPSILON &&
                  candidateSecondary < secondary[offset] - EPSILON)
              ) {
                primary[offset] = candidatePrimary;
                secondary[offset] = candidateSecondary;
                choices[offset] = {
                  type: 'RUN',
                  runStart,
                  plateIndex: extension.plateIndex,
                };
              }
            }
          }
        }

        const result = {
          primary: primary[length],
          secondary: secondary[length],
          choice: choices,
        };
        memo.set(memoKey, result);
        return result;
      }

      const emptyCounts = new Array(NP).fill(0);
      solve(0, activeSets.length - 1, emptyCounts);
      const stacks = new Array(activeSets.length);

      function backtrack(start, end, prefixStack, prefixCounts) {
        if (start > end) return;
        const entry = memo.get(packMemoKey(start, end, encode(prefixCounts)));
        if (!entry) throw new Error('Missing optimiser reconstruction state');
        let setIndex = end;
        while (setIndex >= start) {
          const selection = entry.choice[setIndex - start + 1];
          if (!selection) throw new Error('No exact plate arrangement found');
          if (selection.type === 'STOP') {
            stacks[setIndex] = prefixStack.slice();
            setIndex--;
            continue;
          }

          const counts = prefixCounts.slice();
          counts[selection.plateIndex]++;
          backtrack(
            selection.runStart,
            setIndex,
            prefixStack.concat(selection.plateIndex),
            counts,
          );
          setIndex = selection.runStart - 1;
        }
      }

      backtrack(0, activeSets.length - 1, [], emptyCounts);
      return stacks;
    }

    function transitionStats(previous, next) {
      let shared = 0;
      while (
        shared < previous.length &&
        shared < next.length &&
        previous[shared] === next[shared]
      ) shared++;

      let kg = 0;
      let sqrtKg = 0;
      for (let index = shared; index < previous.length; index++) {
        const weight = plateKg[previous[index]];
        kg += weight;
        sqrtKg += Math.sqrt(weight);
      }
      for (let index = shared; index < next.length; index++) {
        const weight = plateKg[next[index]];
        kg += weight;
        sqrtKg += Math.sqrt(weight);
      }

      const removedCount = previous.length - shared;
      const addedCount = next.length - shared;
      const perSideMoves = removedCount + addedCount;
      return {
        removedCount,
        addedCount,
        bothSidesMoves: perSideMoves * sided,
        bothSidesKg: kg * sided,
        bothSidesSqrtKg: sqrtKg * sided,
      };
    }

    const stacks = optimizeRun();
    const output = [];
    let previousStack = [];

    for (let originalIndex = 0; originalIndex < sets.length; originalIndex++) {
      const set = sets[originalIndex];
      if (set.invalid) {
        output.push({
          valid: false,
          skipped: true,
          total: set.total,
          reason: set.reason,
        });
        continue;
      }

      const activeIndex = activeIndexByOriginal.get(originalIndex);
      const stack = stacks[activeIndex];
      const transition = transitionStats(activeIndex === 0 ? [] : previousStack, stack);
      const entry = {
        valid: true,
        total: set.total,
        stack,
        removedCount: transition.removedCount,
        addedCount: transition.addedCount,
        bothSidesMoves: transition.bothSidesMoves,
        bothSidesKg: transition.bothSidesKg,
        bothSidesSqrtKg: transition.bothSidesSqrtKg,
        isStart: activeIndex === 0,
      };

      if (activeIndex === activeSets.length - 1) {
        const cleanup = transitionStats(stack, []);
        entry.cleanup = {
          removedCount: cleanup.removedCount,
          bothSidesMoves: cleanup.bothSidesMoves,
          bothSidesKg: cleanup.bothSidesKg,
          bothSidesSqrtKg: cleanup.bothSidesSqrtKg,
        };
      }

      output.push(entry);
      previousStack = stack;
    }

    return output;
  }

  return { optimize };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAlgoLib };
}
