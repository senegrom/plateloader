# Plate Loader

Plate Loader finds an exact, globally optimal sequence of plate stacks for a list of deadlift sets. It runs entirely in the browser and can be installed as an offline-capable web app.

## Optimisation semantics

The available plates are 25, 20, 15, 10, 5, 2.5 and 1.25 kg. A simple preset applies one available count to every denomination; an optional custom-stock panel can override each denomination individually. Stock is specified per side for symmetric loading and as a total count for one-sided loading.

The optimiser preserves the longest common inner stack between consecutive valid sets and minimises one of three lexicographic objectives:

- **Plate moves:** total plates added or removed; ties favour fewer kilograms handled.
- **Kilograms moved:** total plate mass handled; ties favour fewer plate moves.
- **Σ√kg moved:** the sum of square roots of individual plate weights handled; ties favour fewer plate moves. Because this cost is sublinear, it discounts heavier plates relative to the kilograms-moved objective and usually favours fewer, larger plates.

Invalid entries remain visible but are skipped as physical states, so valid sets on either side remain optimised together. The final valid set includes the unload back to the empty loading state.

## Exactness and limits

The dynamic programme is exhaustive: it does not use a heuristic or complexity guard. The browser UI supports up to 50 sets, up to 4,096 input characters, up to six plates of each denomination, total weights up to 1,000 kg, optional one-sided loading, monotonic stacks and an ordered pinned starting stack.

Plate-count vectors use collision-free mixed-radix state encoding. Dense state spaces use compact membership bitsets; larger direct-API calls retain an exact sparse representation. The interval search memoises one all-pairs cost table per prefix and contiguous block of sets, so session-shaped inputs whose sets share long inner stacks optimise in milliseconds instead of tens of seconds. Repeated set weights share feasibility data, and impossible inventory branches are pruned without changing the search space or result.

The starting stack may exceed the selected stock count because those plates are already physically present. Its UI length is bounded to reject implausible crafted URL or local-storage state, not to approximate the optimiser.

Warm-up targets must be exactly loadable with the selected bar, sidedness, stock and starting inventory. Intermediate sets are projected downward to the nearest loadable weight at or below each intended percentage, so a warm-up never exceeds its stated stage.

Monotonic mode preserves the declared physical starting-stack order. An incompatible stack is rejected rather than silently rearranged.

## Development

```sh
npm test
npm install
npm run test:browser
```

The dependency-free Node suite covers the exact optimiser, state handling, worker and service-worker behavior, and deterministic build boundaries. The Playwright smoke suite exercises the built app under the exact `/plateloader/` project path, including keyboard navigation, optional custom inventory, shared-state restoration and offline operation. Unit tests run on both Ubuntu and Windows in CI.

The build is deterministic, single-writer, crash-recoverable and atomic. It writes `_site`, copies source assets without ad-hoc HTML/CSS/JavaScript rewriting, injects a content-only service-worker build ID, retries transient Windows rename failures, and leaves all source files readable. App-shell cache generations are immutable and isolated by the exact service-worker registration scope. Runtime cache failures degrade to network loading instead of discarding a successful response.

The worker-first runtime loads the exact optimiser on the main thread only as a fallback. A restrictive same-origin content-security policy keeps scripts, styles, workers, fonts and network requests inside the app. Each distinct font payload is stored once, and committed text files use LF so builds remain reproducible across platforms.

URL state is updated immediately while local storage is coalesced during typing and flushed when the page hides, so rapid reloads retain the latest input.

Optional per-denomination inventory is included in the existing share hash, so links remain self-contained and do not rely on recipient browser storage.
