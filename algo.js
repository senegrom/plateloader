'use strict';

// Exact plate-loader optimisation algorithm. It is self-contained, has no DOM
// access and is shared by the page, Web Worker and regression tests.
function buildAlgoLib() {
  'use strict';

  const MODES = new Set(['count', 'kg', 'sqrt']);
  const DENSE_MEMBERSHIP_LIMIT = 32_000_000;
  const EPSILON = 1e-9;

  function optimize(weights, mode, plateMax, PLATES, BAR, startStack, monotonic, sided, options = {}) {
    const leaveLoaded = options && options.leaveLoaded === true;
    // A caller may bound a synchronous fallback. Expiry aborts the entire
    // calculation: no heuristic or partial solution is ever returned.
    const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const duration = options && options.timeLimitMs;
    const deadline = Number.isFinite(duration) ? clock() + Math.max(0, duration) : Infinity;
    let operations = 0;
    function checkTime(force = false) {
      if (deadline === Infinity || (!force && (++operations & 1023) !== 0)) return;
      if (clock() >= deadline) {
        const error = new Error('Exact calculation exceeded the synchronous fallback time budget.');
        error.name = 'TimeoutError';
        throw error;
      }
    }
    checkTime(true);
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
      if (monotonic) {
        for (let index = 1; index < startStack.length; index++) {
          if (startStack[index] < startStack[index - 1]) {
            throw new RangeError(
              'Monotonic starting stack must be ordered heaviest to lightest',
            );
          }
        }
      }

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
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
          },
          has: (key) => keys.has(key),
        };
      }

      const words = new Uint32Array(Math.ceil(stateCount / 32));
      return {
        add(key) {
          const wordIndex = Math.floor(key / 32);
          const mask = 1 << (key & 31);
          if ((words[wordIndex] & mask) !== 0) return false;
          words[wordIndex] |= mask;
          return true;
        },
        has(key) {
          const wordIndex = Math.floor(key / 32);
          return (words[wordIndex] & (1 << (key & 31))) !== 0;
        },
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
        checkTime();
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
        // The descending loop always ends at zero, which restores the
        // "counts are zero from here outward" invariant the callers rely on.
        for (let count = maximum; count >= 0; count--) {
          counts[index] = count;
          enumerate(index + 1, remaining - count * unit);
        }
      }

      enumerate(0, targetUnits);

      if (!monotonic) {
        // Compute the downward closure once. The legacy implementation
        // re-enumerated every sub-multiset for every combination, revisiting
        // the same prefix many times when combinations overlapped.
        while (pending.length) {
          checkTime();
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
    // A pinned starting stack matters only when at least one requested set can
    // actually be performed; otherwise do not invent a START/UNLOAD-only plan.
    const userSetOffset = startStack ? 1 : 0;
    const userSets = sets.slice(userSetOffset);
    if (!userSets.some((set) => !set.invalid)) {
      return userSets.map((set) => ({
        valid: false,
        total: set.total,
        reason: set.reason,
      }));
    }

    // Optimise all valid entries together, then reinsert invalid rows without
    // forcing an unload/reload boundary.
    const physicalSets = sets.filter((set) => !set.invalid);
    const activeSets = [];
    const activeMap = [];
    // Weighted common-prefix distance is a tree metric. A run of identical
    // feasible targets can therefore use one stack throughout without raising
    // either objective. Keep pinned starts separate (their feasible set differs).
    // Invalid annotations do not interrupt a physical run.
    for (const set of physicalSets) {
      const previous = activeSets[activeSets.length - 1];
      if (!previous || previous.pinnedKey !== undefined || set.pinnedKey !== undefined ||
          previous.targetUnits !== set.targetUnits) activeSets.push(set);
      activeMap.push(activeSets.length - 1);
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

    // The sets admitting a prefix form contiguous blocks. All-pairs values
    // F(s, j) = cost of covering sets s..j under the prefix, for every s <= j
    // in one block, are computed together: child lookups are gathered once
    // per (plate, run start), and the cubic all-pairs pass then runs over
    // contiguous typed arrays with exact loop bounds. Candidates are examined
    // in the original order (stop, then plates ascending, then run start
    // descending, strict improvement only), so results are identical to the
    // per-interval formulation. Block records and values live in flat arenas.
    function optimizeRun() {
      const setCount = activeSets.length;
      const memo = new Map();
      const maxTableKey = (stateCount - 1) * setCount + setCount - 1;
      const packTableKey = Number.isSafeInteger(maxTableKey)
        ? (start, prefixKey) => prefixKey * setCount + start
        : (start, prefixKey) => `${prefixKey}|${start}`;
      const admits = (setIndex, prefixKey) =>
        activeSets[setIndex].feasibility.prefixKeys.has(prefixKey);

      let blockCount = 0;
      let blockStart = new Int32Array(1024);
      let blockLength = new Int32Array(1024);
      let blockValues = new Int32Array(1024);
      let blockChoices = new Int32Array(1024);
      let blockPlates = new Int32Array(1024);
      let values = new Float64Array(1 << 12);
      let valuesUsed = 0;
      let choices = new Int32Array(1 << 12);
      let choicesUsed = 0;
      let plates = new Int32Array(1 << 12);
      let platesUsed = 0;
      let scratch = new Float64Array(1 << 10);
      let runMinimum = new Int32Array(1 << 10);
      let stops = new Uint8Array(1 << 10);

      const growInt32 = (array, needed) => {
        if (needed <= array.length) return array;
        const next = new Int32Array(Math.max(needed, array.length * 2));
        next.set(array);
        return next;
      };
      const growFloat64 = (array, needed) => {
        if (needed <= array.length) return array;
        const next = new Float64Array(Math.max(needed, array.length * 2));
        next.set(array);
        return next;
      };

      // Row i (start s0 + i) holds offsets m = 0..L-i.
      const rowStart = (L, i) => i * (L + 1) - ((i * (i - 1)) >> 1);
      const blockTotal = (L) => (L * (L + 3)) >> 1;

      function block(start, prefixKey, prefixUnits) {
        const cached = memo.get(packTableKey(start, prefixKey));
        if (cached !== undefined) return cached;
        let s0 = start;
        while (s0 > 0 && admits(s0 - 1, prefixKey)) s0--;
        let end = start;
        while (end + 1 < setCount && admits(end + 1, prefixKey)) end++;
        const id = computeBlock(s0, end, prefixKey, prefixUnits);
        for (let s = s0; s <= end; s++) memo.set(packTableKey(s, prefixKey), id);
        return id;
      }

      function computeBlock(s0, end, prefixKey, prefixUnits) {
        checkTime();
        const L = end - s0 + 1;

        let largestPlateIndex = -1;
        if (monotonic) {
          for (let index = NP - 1; index >= 0; index--) {
            if (countAt(prefixKey, index) > 0) {
              largestPlateIndex = index;
              break;
            }
          }
        }
        const extensionPlates = [];
        for (let plateIndex = 0; plateIndex < NP; plateIndex++) {
          if (countAt(prefixKey, plateIndex) >= plateMax[plateIndex]) continue;
          if (monotonic && plateIndex < largestPlateIndex) continue;
          extensionPlates.push(plateIndex);
        }
        const extensionCount = extensionPlates.length;

        // Pass 1: make every child block exist. This is the only recursive
        // step, so the shared scratch buffers below are never in use here.
        for (let e = 0; e < extensionCount; e++) {
          const plateIndex = extensionPlates[e];
          const key = prefixKey + multipliers[plateIndex];
          const extendedUnits = prefixUnits + units[plateIndex];
          for (let r = s0; r <= end; r++) {
            if (admits(r, key)) block(r, key, extendedUnits);
          }
        }

        // Pass 2: gather W[e](r, j) = plate cost + child value for the run
        // r..j under prefix+plate, column-major by j so the inner loop of
        // pass 3 walks contiguous memory. runMinimum[e][j] is the smallest
        // admitted run start for that column (j + 1 when j is not admitted).
        const pairs = (L * (L + 1)) >> 1;
        const secondaryBase = extensionCount * pairs;
        // These three are rewritten in full for every block, so growth
        // allocates fresh rather than copying contents that are about to die.
        if (scratch.length < 2 * secondaryBase) {
          scratch = new Float64Array(Math.max(2 * secondaryBase, scratch.length * 2));
        }
        if (runMinimum.length < extensionCount * L) {
          runMinimum = new Int32Array(Math.max(extensionCount * L, runMinimum.length * 2));
        }
        if (stops.length < L) stops = new Uint8Array(Math.max(L, stops.length * 2));
        for (let index = 0; index < extensionCount * L; index++) runMinimum[index] = L;
        for (let e = 0; e < extensionCount; e++) {
          const plateIndex = extensionPlates[e];
          const key = prefixKey + multipliers[plateIndex];
          const primaryCost = primaryPlateCost[plateIndex];
          const secondaryCost = secondaryPlateCost[plateIndex];
          const base = e * pairs;
          for (let r = s0; r <= end; r++) {
            if (!admits(r, key)) continue;
            const child = memo.get(packTableKey(r, key));
            const childStart = blockStart[child];
            const childLength = blockLength[child];
            const childRow = blockValues[child] + rowStart(childLength, r - childStart);
            const childRowSecondary = childRow + blockTotal(childLength);
            const childEnd = childStart + childLength - 1;
            if (r === childStart) {
              for (let j = childStart; j <= childEnd; j++) {
                runMinimum[e * L + (j - s0)] = childStart - s0;
              }
            }
            for (let j = r; j <= childEnd; j++) {
              const offset = j - r + 1;
              const column = j - s0;
              const index = base + ((column * (column + 1)) >> 1) + (r - s0);
              // Normally a plate run costs one add and one removal (the DP
              // uses half-costs). A run ending at the final set costs only its
              // add when leaving the bar loaded. The pinned initial load is a
              // constant, so this remains exact for non-empty starting stacks.
              const factor = leaveLoaded && j === setCount - 1 ? 0.5 : 1;
              scratch[index] = factor * primaryCost + values[childRow + offset];
              scratch[secondaryBase + index] = factor * secondaryCost + values[childRowSecondary + offset];
            }
          }
        }
        for (let i = 0; i < L; i++) {
          const set = activeSets[s0 + i];
          stops[i] = (set.pinnedKey === undefined
            ? prefixUnits === set.targetUnits
            : prefixKey === set.pinnedKey) ? 1 : 0;
        }

        // Pass 3: all-pairs F over the block in the original candidate order.
        const total = blockTotal(L);
        values = growFloat64(values, valuesUsed + 2 * total);
        choices = growInt32(choices, choicesUsed + total);
        const valueBase = valuesUsed;
        const secondaryValueBase = valueBase + total;
        const choiceBase = choicesUsed;
        valuesUsed += 2 * total;
        choicesUsed += total;
        for (let i = 0; i < L; i++) {
          const row = valueBase + rowStart(L, i);
          const rowSecondary = secondaryValueBase + rowStart(L, i);
          const rowChoice = choiceBase + rowStart(L, i);
          values[row] = 0;
          values[rowSecondary] = 0;
          choices[rowChoice] = -2;
          for (let j = i; j < L; j++) {
            // One deadline check per column keeps the budget granularity
            // well under a millisecond without a call in the innermost loop,
            // which cost the normal worker path up to 70% when it ran there.
            checkTime();
            const m = j - i + 1;
            let bestPrimary = Infinity;
            let bestSecondary = Infinity;
            let bestChoice = -2;
            if (stops[j] === 1) {
              bestPrimary = values[row + m - 1];
              bestSecondary = values[rowSecondary + m - 1];
              bestChoice = -1;
            }
            const columnBase = (j * (j + 1)) >> 1;
            for (let e = 0; e < extensionCount; e++) {
              let low = runMinimum[e * L + j];
              if (low > j) continue;
              if (low < i) low = i;
              const base = e * pairs + columnBase;
              const baseSecondary = secondaryBase + base;
              for (let r = j; r >= low; r--) {
                const totalPrimary = values[row + (r - i)] + scratch[base + r];
                const totalSecondary = values[rowSecondary + (r - i)] + scratch[baseSecondary + r];
                if (
                  totalPrimary < bestPrimary - EPSILON ||
                  (totalPrimary <= bestPrimary + EPSILON &&
                    totalSecondary < bestSecondary - EPSILON)
                ) {
                  bestPrimary = totalPrimary;
                  bestSecondary = totalSecondary;
                  bestChoice = e * L + r;
                }
              }
            }
            values[row + m] = bestPrimary;
            values[rowSecondary + m] = bestSecondary;
            choices[rowChoice + m] = bestChoice;
          }
        }

        const id = blockCount++;
        blockStart = growInt32(blockStart, blockCount);
        blockLength = growInt32(blockLength, blockCount);
        blockValues = growInt32(blockValues, blockCount);
        blockChoices = growInt32(blockChoices, blockCount);
        blockPlates = growInt32(blockPlates, blockCount);
        plates = growInt32(plates, platesUsed + extensionCount);
        blockStart[id] = s0;
        blockLength[id] = L;
        blockValues[id] = valueBase;
        blockChoices[id] = choiceBase;
        blockPlates[id] = platesUsed;
        for (let e = 0; e < extensionCount; e++) plates[platesUsed + e] = extensionPlates[e];
        platesUsed += extensionCount;
        return id;
      }

      block(0, 0, 0);
      const stacks = new Array(setCount);

      function backtrack(start, end, prefixStack, prefixKey, prefixUnits) {
        const id = memo.get(packTableKey(start, prefixKey));
        if (id === undefined) throw new Error('Missing optimiser reconstruction state');
        const s0 = blockStart[id];
        const L = blockLength[id];
        const choiceRow = blockChoices[id] + rowStart(L, start - s0);
        let setIndex = end;
        while (setIndex >= start) {
          const choice = choices[choiceRow + (setIndex - start + 1)];
          if (choice === -2) throw new Error('No exact plate arrangement found');

          if (choice === -1) {
            stacks[setIndex] = prefixStack.slice();
            setIndex--;
            continue;
          }

          const plateIndex = plates[blockPlates[id] + Math.floor(choice / L)];
          const runStart = s0 + (choice % L);
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

      backtrack(0, setCount - 1, [], 0, 0);
      return stacks;
    }

    // Memory-efficient form of the same interval recurrence. Whole blocks and
    // row prefixes are shared only for exactly equal sequences of feasible
    // sets. Costs live for two adjacent prefix-depth layers; only compact
    // reconstruction choices survive. No search candidate is discarded.
    function optimizeRunCompact() {
      const n = activeSets.length;
      const feasible = [...new Set(activeSets.map((set) => set.feasibility))];
      const token = new Map(feasible.map((f, i) => [f, i]));
      const lcp = Array.from({ length: n + 1 }, () => new Uint32Array(n + 1));
      const words = Array.from({ length: n }, () => new Uint32Array(n));
      const wordIds = new Map();
      for (let i = n - 1; i >= 0; i--) {
        checkTime();
        for (let j = n - 1; j >= 0; j--) {
          if (activeSets[i].feasibility === activeSets[j].feasibility) lcp[i][j] = 1 + lcp[i + 1][j + 1];
        }
        for (let j = i; j < n; j++) {
          const key = `${token.get(activeSets[i].feasibility)}|${j > i ? words[i + 1][j] : 0}`;
          if (!wordIds.has(key)) wordIds.set(key, wordIds.size + 1);
          words[i][j] = wordIds.get(key);
        }
      }
      // A pinned state's feasibility object is distinct. Open terminal cells
      // are distinct from closed cells even when their target words match.
      const patternFor = (s, e) => words[s][e] * 2 + Number(leaveLoaded && e === n - 1);
      const layouts = new Map();
      function layoutFor(s, e) {
        const pattern = patternFor(s, e);
        if (layouts.has(pattern)) return layouts.get(pattern);
        const L = e - s + 1;
        const terminal = leaveLoaded && e === n - 1;
        const normalEnd = L - Number(terminal);
        const rows = new Uint32Array(L);
        const shared = new Uint8Array(L);
        let total = 0;
        for (let i = 0; i < L; i++) {
          const length = Math.max(0, normalEnd - i);
          let p = 0;
          while (p < i && lcp[s + i][s + p] < length) p++;
          if (p < i) { rows[i] = rows[p]; shared[i] = 1; }
          else { rows[i] = total; total += length + 1; }
        }
        const tail = total;
        if (terminal) total += L;
        const layout = { rows, shared, total, tail, terminal, normalEnd };
        layouts.set(pattern, layout);
        return layout;
      }
      // A table fits inside one slab. Reusing slabs across layers avoids
      // repeated growth/copies and avoids depending on prompt garbage collection.
      const pageSize = Math.max(32768, n * (n + 5));
      function makeArena(Type) {
        const pages = [];
        let cursor = 0;
        return {
          pages,
          reset() { cursor = 0; },
          allocate(length) {
            let page = Math.floor(cursor / pageSize);
            let offset = cursor % pageSize;
            if (offset + length > pageSize) { page++; offset = 0; }
            if (!pages[page]) pages[page] = new Type(pageSize);
            cursor = page * pageSize + offset + length;
            return page * pageSize + offset;
          },
        };
      }
      const valueArenas = [makeArena(Float64Array), makeArena(Float64Array)];
      const choiceArena = makeArena(NP * n <= 32767 ? Int16Array : Int32Array);
      const tables = [];
      const memo = new Map();
      let size = 0;
      let starts = new Uint32Array(1024);
      let ends = new Uint32Array(1024);
      let next = new Uint32Array(1024);
      let tableIds = new Uint32Array(1024);
      function record(start, end, table, head) {
        if (++size === starts.length) {
          const grow = (array) => { const bigger = new Uint32Array(array.length * 2); bigger.set(array); return bigger; };
          starts = grow(starts); ends = grow(ends); next = grow(next); tableIds = grow(tableIds);
        }
        starts[size] = start; ends[size] = end; next[size] = head; tableIds[size] = table;
        return size;
      }
      const admits = (s, key) => activeSets[s].feasibility.prefixKeys.has(key);
      function find(s, key) {
        let id = memo.get(key) || 0;
        while (id && (s < starts[id] || s > ends[id])) id = next[id];
        return id;
      }
      const seen = createMembership();
      const levels = [[0]];
      seen.add(0);
      for (let depth = 0; depth < levels.length; depth++) {
        const children = [];
        for (const key of levels[depth]) {
          checkTime();
          let last = -1;
          if (monotonic) for (let p = NP - 1; p >= 0; p--) if (countAt(key, p)) { last = p; break; }
          for (let p = 0; p < NP; p++) {
            if (countAt(key, p) >= plateMax[p] || (monotonic && p < last)) continue;
            const child = key + multipliers[p];
            if (!seen.has(child) && feasible.some((f) => f.prefixKeys.has(child))) {
              seen.add(child); children.push(child);
            }
          }
        }
        if (children.length) levels.push(children);
      }
      let scratch = new Float64Array(1024);
      let minimum = new Int32Array(1024);
      let stops = new Uint8Array(n);
      let currentValues, childValues;
      function solve(s, end, key, prefixUnits) {
        checkTime();
        const L = end - s + 1;
        let last = -1;
        if (monotonic) for (let p = NP - 1; p >= 0; p--) if (countAt(key, p)) { last = p; break; }
        const extensions = [];
        for (let p = 0; p < NP; p++) {
          if (countAt(key, p) < plateMax[p] && (!monotonic || p >= last)) extensions.push(p);
        }
        const pairs = L * (L + 1) / 2;
        const secondaryBase = extensions.length * pairs;
        if (scratch.length < 2 * secondaryBase) scratch = new Float64Array(2 * secondaryBase);
        if (minimum.length < extensions.length * L) minimum = new Int32Array(extensions.length * L);
        minimum.fill(L, 0, extensions.length * L);
        for (let e = 0; e < extensions.length; e++) {
          const p = extensions[e];
          const childKey = key + multipliers[p];
          for (let r = s; r <= end; r++) {
            checkTime();
            if (!admits(r, childKey)) continue;
            const child = find(r, childKey);
            if (!child) throw new Error('Missing exact child table');
            const table = tables[tableIds[child]];
            const layout = table.layout;
            const buffer = childValues.pages[Math.floor(table.value / pageSize)];
            const base = table.value % pageSize;
            const relative = r - starts[child];
            const row = layout.rows[relative];
            if (r === starts[child]) {
              for (let j = r; j <= ends[child]; j++) minimum[e * L + j - s] = r - s;
            }
            for (let j = r; j <= ends[child]; j++) {
              const column = j - s;
              const index = e * pairs + column * (column + 1) / 2 + r - s;
              const isTail = layout.terminal && j === n - 1;
              const offset = base + (isTail ? layout.tail + relative : row + j - r + 1);
              const factor = isTail ? 0.5 : 1;
              scratch[index] = factor * primaryPlateCost[p] + buffer[offset];
              scratch[secondaryBase + index] = factor * secondaryPlateCost[p] + buffer[offset + layout.total];
            }
          }
        }
        for (let j = 0; j < L; j++) {
          const set = activeSets[s + j];
          stops[j] = Number(set.pinnedKey === undefined ? set.targetUnits === prefixUnits : set.pinnedKey === key);
        }
        const layout = layoutFor(s, end);
        const { rows, shared, total, tail, terminal, normalEnd } = layout;
        const value = currentValues.allocate(2 * total);
        const choice = choiceArena.allocate(total);
        const values = currentValues.pages[Math.floor(value / pageSize)];
        const choices = choiceArena.pages[Math.floor(choice / pageSize)];
        const v = value % pageSize;
        const c = choice % pageSize;
        for (let i = 0; i < L; i++) {
          const row = v + rows[i];
          const secondaryRow = row + total;
          if (!shared[i]) { values[row] = 0; values[secondaryRow] = 0; choices[c + rows[i]] = -2; }
          for (let j = shared[i] ? normalEnd : i; j < L; j++) {
            checkTime();
            const m = j - i + 1;
            const target = terminal && j === L - 1 ? tail + i : rows[i] + m;
            let bestPrimary = Infinity, bestSecondary = Infinity, bestChoice = -2;
            if (stops[j]) { bestPrimary = values[row + m - 1]; bestSecondary = values[secondaryRow + m - 1]; bestChoice = -1; }
            const column = j * (j + 1) / 2;
            for (let e = 0; e < extensions.length; e++) {
              const low = Math.max(i, minimum[e * L + j]);
              const base = e * pairs + column;
              for (let r = j; r >= low; r--) {
                const p = values[row + r - i] + scratch[base + r];
                const q = values[secondaryRow + r - i] + scratch[secondaryBase + base + r];
                if (p < bestPrimary - EPSILON || (p <= bestPrimary + EPSILON && q < bestSecondary - EPSILON)) {
                  bestPrimary = p; bestSecondary = q;
                  bestChoice = extensions[e] * L + r - i;
                }
              }
            }
            values[v + target] = bestPrimary; values[v + total + target] = bestSecondary;
            choices[c + target] = bestChoice;
          }
        }
        tables.push({ pattern: patternFor(s, end), layout, value, choice });
        return tables.length - 1;
      }
      for (let depth = levels.length - 1; depth >= 0; depth--) {
        currentValues = valueArenas[depth % 2]; currentValues.reset();
        childValues = valueArenas[(depth + 1) % 2];
        for (const key of levels[depth]) {
          checkTime();
          let prefixUnits = 0;
          for (let p = 0; p < NP; p++) prefixUnits += countAt(key, p) * units[p];
          let head = 0;
          for (let s = 0; s < n; s++) {
            if (!admits(s, key)) continue;
            let end = s;
            while (end + 1 < n && admits(end + 1, key)) end++;
            const pattern = patternFor(s, end);
            let same = head;
            while (same && tables[tableIds[same]].pattern !== pattern) same = next[same];
            const table = same ? tableIds[same] : solve(s, end, key, prefixUnits);
            head = record(s, end, table, head);
            s = end;
          }
          memo.set(key, head);
        }
      }
      const stacks = new Array(n);
      function reconstruct(start, end, prefix, key) {
        const id = find(start, key);
        if (!id) throw new Error('Missing exact reconstruction table');
        const table = tables[tableIds[id]];
        const { layout } = table;
        const L = ends[id] - starts[id] + 1;
        const relative = start - starts[id];
        const choices = choiceArena.pages[Math.floor(table.choice / pageSize)];
        const base = table.choice % pageSize;
        while (end >= start) {
          const offset = layout.terminal && end === n - 1 ? layout.tail + relative : layout.rows[relative] + end - start + 1;
          const choice = choices[base + offset];
          if (choice === -2) throw new Error('No exact plate arrangement found');
          if (choice === -1) { stacks[end--] = prefix.slice(); continue; }
          const p = Math.floor(choice / L);
          const runStart = start + choice % L;
          prefix.push(p); reconstruct(runStart, end, prefix, key + multipliers[p]); prefix.pop();
          end = runStart - 1;
        }
      }
      reconstruct(0, n - 1, [], 0);
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

    // Keep the existing small-session hot path. Both implementations use the
    // same recurrence and candidate order; this selects storage, not accuracy.
    const compactTables = options && options.compactTables === true ||
      ((!options || options.compactTables !== false) && activeSets.length > 1 &&
       activeSets.length * activeSets.length * stateCount > 2_000_000);
    const stacks = compactTables ? optimizeRunCompact() : optimizeRun();
    const output = [];
    let previousStack = [];
    let activeIndex = 0;

    for (const set of sets) {
      if (set.invalid) {
        output.push({ valid: false, total: set.total, reason: set.reason });
        continue;
      }

      const stack = stacks[activeMap[activeIndex]].slice();
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

      if (!leaveLoaded && activeIndex === physicalSets.length - 1) {
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

  // optimize() prepends the pinned starting state only when at least one
  // requested set is valid, so callers detect it from the result length rather
  // than repeating that rule.
  function hasPinnedStart(weights, startStack, results) {
    const requested = Array.isArray(weights) ? weights.length : 0;
    return Boolean(
      Array.isArray(startStack) && startStack.length &&
      Array.isArray(results) && results.length === requested + 1,
    );
  }

  return { optimize, hasPinnedStart };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildAlgoLib };
}
