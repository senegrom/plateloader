'use strict';

// Exact plate-loader optimisation algorithm. It is self-contained, has no DOM
// access and is shared by the page, Web Worker and regression tests.
function buildAlgoLib() {
  'use strict';

  const MODES = new Set(['count', 'kg', 'sqrt']);
  const DENSE_MEMBERSHIP_LIMIT = 32_000_000;
  const EPSILON = 1e-9;

  function optimize(weights, mode, plateMax, PLATES, BAR, startStack, monotonic, sided) {
    if (!Array.isArray(PLATES) || PLATES.length === 0) {
      throw new TypeError('At least one plate denomination is required');
    }

    const NP = PLATES.length;
    if (NP > 32767) throw new RangeError('Too many plate denominations');
    if (sided !== 1 && sided !== 2) sided = 2;
    if (!MODES.has(mode)) mode = 'count';

    BAR = Number(BAR);
    if (!Number.isFinite(BAR) || BAR < 0) {
      throw new RangeError('Bar weight must be non-negative');
    }

    const plateKg = PLATES.map((plate) => Number(
      typeof plate === 'number' ? plate : plate && plate.kg,
    ));
    const units = plateKg.map((kg) => {
      const exact = kg * 4;
      const rounded = Math.round(exact);
      if (!Number.isFinite(kg) || kg <= 0 || Math.abs(exact - rounded) > 1e-6) {
        throw new RangeError('Plate weights must be positive quarter-kilogram denominations');
      }
      return rounded;
    });
    const sqrtPlateKg = plateKg.map(Math.sqrt);
    if (monotonic) {
      for (let index = 1; index < NP; index++) {
        if (plateKg[index] > plateKg[index - 1] + EPSILON) {
          throw new RangeError(
            'Monotonic mode requires denominations ordered heaviest to lightest',
          );
        }
      }
    }

    plateMax = Array.from({ length: NP }, (_, index) => {
      const maximum = Number(Array.isArray(plateMax) ? plateMax[index] : 0);
      return Number.isFinite(maximum) && maximum > 0 ? Math.trunc(maximum) : 0;
    });
    weights = Array.isArray(weights) ? weights.slice() : [];

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
    if (Array.isArray(startStack) && startStack.length) {
      startStack = startStack.slice();
      for (const plateIndex of startStack) {
        if (!Number.isInteger(plateIndex) || plateIndex < 0 || plateIndex >= NP) {
          throw new RangeError('Starting stack contains an invalid plate index');
        }
      }
      if (monotonic) startStack.sort((a, b) => a - b);

      let startKg = BAR;
      const startCounts = new Array(NP).fill(0);
      for (const plateIndex of startStack) {
        startKg += sided * plateKg[plateIndex];
        startCounts[plateIndex]++;
      }
      plateMax = plateMax.map((maximum, plateIndex) =>
        Math.max(maximum, startCounts[plateIndex]));
      weights.unshift(startKg);
    } else {
      startStack = null;
    }

    // Inventory above the heaviest requested set can never participate in a
    // solution. Trim only those provably irrelevant counts before constructing
    // the exact mixed-radix state space. This is not a heuristic or a user cap.
    let maximumTargetUnits = 0;
    for (const weight of weights) {
      const exactTotalUnits = (Number(weight) - BAR) * 4;
      const roundedTotalUnits = Math.round(exactTotalUnits);
      if (
        Number.isFinite(exactTotalUnits) &&
        exactTotalUnits >= 0 &&
        Math.abs(exactTotalUnits - roundedTotalUnits) <= 1e-6 &&
        roundedTotalUnits % totalIncrementUnits === 0
      ) {
        maximumTargetUnits = Math.max(
          maximumTargetUnits,
          roundedTotalUnits / sided,
        );
      }
    }
    plateMax = plateMax.map((maximum, plateIndex) =>
      Math.min(maximum, Math.floor(maximumTargetUnits / units[plateIndex])));

    // Exact suffix bounds prune targets that exceed the remaining inventory or
    // cannot be formed by the remaining denomination lattice. This changes no
    // search result; it only avoids exploring provably impossible branches.
    const suffixMaximumUnits = new Array(NP + 1).fill(0);
    const suffixDenominationGcd = new Array(NP + 1).fill(0);
    for (let index = NP - 1; index >= 0; index--) {
      suffixMaximumUnits[index] =
        suffixMaximumUnits[index + 1] + units[index] * plateMax[index];
      suffixDenominationGcd[index] = plateMax[index] > 0
        ? gcd(units[index], suffixDenominationGcd[index + 1])
        : suffixDenominationGcd[index + 1];
    }
    const maximumPlateUnits = suffixMaximumUnits[0];

    // Mixed-radix encoding replaces the legacy nibble representation and
    // keeps every feasible count vector collision-free for the effective caps.
    const multipliers = new Array(NP);
    let stateCount = 1;
    for (let index = NP - 1; index >= 0; index--) {
      multipliers[index] = stateCount;
      stateCount *= plateMax[index] + 1;
      if (!Number.isSafeInteger(stateCount)) {
        throw new RangeError('Plate-state space exceeds safe integer encoding');
      }
    }
    const encode = (counts) => {
      let value = 0;
      for (let index = 0; index < NP; index++) {
        value += counts[index] * multipliers[index];
      }
      return value;
    };

    // The normal UI state space is dense enough that a bitset is dramatically
    // smaller than a Set. Very large direct-API states retain an exact sparse
    // Set fallback rather than imposing a new limit or approximation.
    function createMembership() {
      if (stateCount > DENSE_MEMBERSHIP_LIMIT) {
        const keys = new Set();
        return {
          add(key) {
            const previousSize = keys.size;
            keys.add(key);
            return keys.size !== previousSize;
          },
          has: (key) => keys.has(key),
          get size() { return keys.size; },
        };
      }

      const words = new Uint32Array(Math.ceil(stateCount / 32));
      let size = 0;
      return {
        add(key) {
          const wordIndex = Math.floor(key / 32);
          const mask = 1 << (key & 31);
          if ((words[wordIndex] & mask) !== 0) return false;
          words[wordIndex] |= mask;
          size++;
          return true;
        },
        has(key) {
          const wordIndex = Math.floor(key / 32);
          return (words[wordIndex] & (1 << (key & 31))) !== 0;
        },
        get size() { return size; },
      };
    }

    const countAt = (key, plateIndex) =>
      Math.floor(key / multipliers[plateIndex]) % (plateMax[plateIndex] + 1);

    const feasibilityCache = new Map();
    function feasibilityFor(targetUnits) {
      const cached = feasibilityCache.get(targetUnits);
      if (cached !== undefined) return cached;

      const prefixKeys = createMembership();
      const pending = monotonic ? null : [];
      const counts = new Array(NP).fill(0);
      let hasCombinations = false;

      function registerCombination() {
        hasCombinations = true;
        if (monotonic) {
          // A monotonic stack has exactly one count-vector prefix at every
          // depth, so add that chain directly from the live combination.
          let prefixKey = 0;
          prefixKeys.add(prefixKey);
          for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
            for (let copy = 0; copy < counts[plateIndex]; copy++) {
              prefixKey += multipliers[plateIndex];
              prefixKeys.add(prefixKey);
            }
          }
          return;
        }

        const key = encode(counts);
        if (prefixKeys.add(key)) pending.push(key);
      }

      function enumerate(index, remaining) {
        if (remaining === 0) {
          registerCombination();
          return;
        }
        if (
          index >= NP ||
          remaining > suffixMaximumUnits[index] ||
          (suffixDenominationGcd[index] !== 0 &&
            remaining % suffixDenominationGcd[index] !== 0)
        ) return;

        const unit = units[index];
        const maximum = Math.min(plateMax[index], Math.floor(remaining / unit));
        for (let count = maximum; count >= 0; count--) {
          counts[index] = count;
          enumerate(index + 1, remaining - count * unit);
        }
        counts[index] = 0;
      }

      enumerate(0, targetUnits);

      if (!monotonic) {
        // Compute the downward closure once. The legacy implementation
        // re-enumerated every sub-multiset for every combination, revisiting
        // the same prefix many times when combinations overlapped.
        while (pending.length) {
          const key = pending.pop();
          for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
            if (countAt(key, plateIndex) === 0) continue;
            const child = key - multipliers[plateIndex];
            if (prefixKeys.add(child)) pending.push(child);
          }
        }
      }

      const feasibility = { hasCombinations, prefixKeys };
      feasibilityCache.set(targetUnits, feasibility);
      return feasibility;
    }

    const sets = weights.map((weight, index) => {
      const total = Number(weight);
      const isPinned = Boolean(startStack && index === 0);

      if (isPinned) {
        const counts = new Array(NP).fill(0);
        for (const plateIndex of startStack) counts[plateIndex]++;
        const pinnedKey = encode(counts);
        const prefixKeys = createMembership();
        const prefix = new Array(NP).fill(0);
        prefixKeys.add(0);
        for (const plateIndex of startStack) {
          prefix[plateIndex]++;
          prefixKeys.add(encode(prefix));
        }
        return {
          invalid: false,
          total,
          pinnedKey,
          targetUnits: Math.round((total - BAR) * 4 / sided),
          feasibility: { hasCombinations: true, prefixKeys },
        };
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
      if (targetUnits > maximumPlateUnits) {
        return {
          invalid: true,
          total,
          reason: 'No plate combination available with current stock',
        };
      }

      const feasibility = feasibilityFor(targetUnits);
      if (!feasibility.hasCombinations) {
        return {
          invalid: true,
          total,
          reason: 'No plate combination available with current stock',
        };
      }
      return { invalid: false, total, targetUnits, feasibility };
    });

    // Invalid user entries are display annotations, not physical bar states.
    // Optimise all valid entries together, then reinsert invalid rows without
    // forcing an unload/reload boundary.
    const activeSets = sets.filter((set) => !set.invalid);
    if (activeSets.length === 0) {
      return sets.map((set) => ({ valid: false, total: set.total, reason: set.reason }));
    }

    const primaryPlateCost = new Float64Array(NP);
    const secondaryPlateCost = new Float64Array(NP);
    for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
      primaryPlateCost[plateIndex] = sided * (
        mode === 'count' ? 1 :
        mode === 'kg' ? plateKg[plateIndex] :
        sqrtPlateKg[plateIndex]
      );
      secondaryPlateCost[plateIndex] = sided * (
        mode === 'count' ? plateKg[plateIndex] : 1
      );
    }

    const intervalBase = activeSets.length + 1;
    const prefixBase = intervalBase * intervalBase;
    const maxPackedKey = (stateCount - 1) * prefixBase +
      (activeSets.length - 1) * intervalBase + activeSets.length - 1;
    const numericMemoKeys = Number.isSafeInteger(maxPackedKey);
    const packMemoKey = numericMemoKeys
      ? (start, end, prefixKey) => prefixKey * prefixBase + start * intervalBase + end
      : (start, end, prefixKey) => `${prefixKey}|${start}|${end}`;

    function optimizeRun() {
      const memo = new Map();
      const emptyResult = { primary: 0, secondary: 0 };

      function evaluate(start, end, prefixKey, prefixUnits, recordChoices) {
        const length = end - start + 1;
        const primary = new Float64Array(length + 1);
        const secondary = new Float64Array(length + 1);
        primary.fill(Infinity);
        secondary.fill(Infinity);
        primary[0] = 0;
        secondary[0] = 0;
        const choices = recordChoices ? new Array(length + 1).fill(-2) : null;

        let largestPlateIndex = -1;
        if (monotonic) {
          for (let index = NP - 1; index >= 0; index--) {
            if (countAt(prefixKey, index) > 0) {
              largestPlateIndex = index;
              break;
            }
          }
        }

        const extensions = [];
        for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
          if (countAt(prefixKey, plateIndex) >= plateMax[plateIndex]) continue;
          if (monotonic && plateIndex < largestPlateIndex) continue;
          extensions.push({
            plateIndex,
            key: prefixKey + multipliers[plateIndex],
          });
        }

        for (let setIndex = start; setIndex <= end; setIndex++) {
          const offset = setIndex - start + 1;
          const set = activeSets[setIndex];

          const canStop = set.pinnedKey === undefined
            ? prefixUnits === set.targetUnits
            : prefixKey === set.pinnedKey;
          if (canStop) {
            const previousPrimary = primary[offset - 1];
            const previousSecondary = secondary[offset - 1];
            if (
              previousPrimary < primary[offset] - EPSILON ||
              (previousPrimary <= primary[offset] + EPSILON &&
                previousSecondary < secondary[offset] - EPSILON)
            ) {
              primary[offset] = previousPrimary;
              secondary[offset] = previousSecondary;
              if (choices) choices[offset] = -1;
            }
          }

          for (const extension of extensions) {
            if (!set.feasibility.prefixKeys.has(extension.key)) continue;
            for (let runStart = setIndex; runStart >= start; runStart--) {
              if (
                runStart < setIndex &&
                !activeSets[runStart].feasibility.prefixKeys.has(extension.key)
              ) break;

              const inner = solve(
                runStart, setIndex, extension.key,
                prefixUnits + units[extension.plateIndex],
              );
              const previousOffset = runStart - start;
              const candidatePrimary = primary[previousOffset] +
                primaryPlateCost[extension.plateIndex] + inner.primary;
              const candidateSecondary = secondary[previousOffset] +
                secondaryPlateCost[extension.plateIndex] + inner.secondary;

              if (
                candidatePrimary < primary[offset] - EPSILON ||
                (candidatePrimary <= primary[offset] + EPSILON &&
                  candidateSecondary < secondary[offset] - EPSILON)
              ) {
                primary[offset] = candidatePrimary;
                secondary[offset] = candidateSecondary;
                if (choices) {
                  choices[offset] = runStart * NP + extension.plateIndex;
                }
              }
            }
          }
        }

        return {
          primary: primary[length],
          secondary: secondary[length],
          choices,
        };
      }

      function solve(start, end, prefixKey, prefixUnits) {
        if (start > end) return emptyResult;
        const memoKey = packMemoKey(start, end, prefixKey);
        const cached = memo.get(memoKey);
        if (cached !== undefined) return cached;
        const evaluated = evaluate(start, end, prefixKey, prefixUnits, false);
        const result = {
          primary: evaluated.primary,
          secondary: evaluated.secondary,
        };
        memo.set(memoKey, result);
        return result;
      }

      solve(0, activeSets.length - 1, 0, 0);
      const stacks = new Array(activeSets.length);

      function backtrack(start, end, prefixStack, prefixKey, prefixUnits) {
        if (start > end) return;
        const entry = memo.get(packMemoKey(start, end, prefixKey));
        if (!entry) throw new Error('Missing optimiser reconstruction state');
        const reconstruction = evaluate(start, end, prefixKey, prefixUnits, true);
        if (
          Math.abs(reconstruction.primary - entry.primary) > EPSILON ||
          Math.abs(reconstruction.secondary - entry.secondary) > EPSILON
        ) throw new Error('Optimiser reconstruction cost changed');

        let setIndex = end;
        while (setIndex >= start) {
          const offset = setIndex - start + 1;
          const selection = reconstruction.choices[offset];
          if (selection === -2) throw new Error('No exact plate arrangement found');

          if (selection === -1) {
            stacks[setIndex] = prefixStack.slice();
            setIndex--;
            continue;
          }

          const runStart = Math.floor(selection / NP);
          const plateIndex = selection % NP;
          prefixStack.push(plateIndex);
          backtrack(
            runStart,
            setIndex,
            prefixStack,
            prefixKey + multipliers[plateIndex],
            prefixUnits + units[plateIndex],
          );
          prefixStack.pop();
          setIndex = runStart - 1;
        }
      }

      backtrack(0, activeSets.length - 1, [], 0, 0);
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
        const plateIndex = previous[index];
        kg += plateKg[plateIndex];
        sqrtKg += sqrtPlateKg[plateIndex];
      }
      for (let index = shared; index < next.length; index++) {
        const plateIndex = next[index];
        kg += plateKg[plateIndex];
        sqrtKg += sqrtPlateKg[plateIndex];
      }

      const removedCount = previous.length - shared;
      const addedCount = next.length - shared;
      return {
        removedCount,
        addedCount,
        bothSidesMoves: (removedCount + addedCount) * sided,
        bothSidesKg: kg * sided,
        bothSidesSqrtKg: sqrtKg * sided,
      };
    }

    const stacks = optimizeRun();
    const output = [];
    let previousStack = [];
    let activeIndex = 0;

    for (const set of sets) {
      if (set.invalid) {
        output.push({ valid: false, total: set.total, reason: set.reason });
        continue;
      }

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
      };

      if (activeIndex === activeSets.length - 1) {
        const cleanup = transitionStats(stack, []);
        entry.cleanup = {
          bothSidesMoves: cleanup.bothSidesMoves,
          bothSidesKg: cleanup.bothSidesKg,
          bothSidesSqrtKg: cleanup.bothSidesSqrtKg,
        };
      }

      output.push(entry);
      previousStack = stack;
      activeIndex++;
    }

    return output;
  }

  return { optimize };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAlgoLib };
}
