# Plate Loader

Plate Loader finds an exact, globally optimal sequence of plate stacks for a list of deadlift sets. It runs entirely in the browser and can be installed as an offline-capable web app.

## Loading and workout views

Every valid set shows the physical plate order **from the collar outward**, plus explicit instructions to remove outer plates first, retain the shared inner stack and add the new outer plates in order. Compact view hides the diagram, not the loading instructions or any required plates. Denomination totals are a secondary inventory summary, not a suggested loading order.

Settings are collapsed to keep the mobile planner short. Workout view shows the current set, previous/next controls and the next weight. Progress is stored locally and restored only when the plan still matches. The full sequence remains available through **Plan / all sets**.

**Edit remaining sets from this bar** treats the displayed set as complete and its stack as already loaded. Check the physical bar first. The remaining list is re-optimised from that exact ordered stack, retaining invalid annotations and any starting inventory already unloaded during the workout. Retained inventory is shown in settings, can be reset, and is included in shared links.

Clear, Load example, Generate warmup, Clear starting stack, Reset carried inventory and replanning offer Undo (up to ten replacements during the current page session). Warm-up targets default to the last entered weight, then the previous generated target, then 140 kg, projected down to an achievable load under the current settings.

## Optimisation semantics

The available plates are 25, 20, 15, 10, 5, 2.5 and 1.25 kg. A simple preset applies one available count to every denomination; an optional custom-stock panel can override each denomination individually. Stock is specified per side for symmetric loading and as a total count for one-sided loading.

The optimiser preserves the longest common inner stack between consecutive valid sets and minimises one of three lexicographic objectives:

- **Plate moves:** total plates added or removed; ties favour fewer kilograms handled.
- **Kilograms moved:** total plate mass handled; ties favour fewer plate moves.
- **Σ√kg moved:** the sum of square roots of individual plate weights handled; ties favour fewer plate moves. Because this cost is sublinear, it discounts heavier plates relative to the kilograms-moved objective and usually favours fewer, larger plates.

Invalid entries remain visible but are skipped as physical states, so valid sets on either side remain optimised together. By default the final valid set includes the unload back to the empty loading state. **Leave the final set loaded** changes the actual optimisation objective: plate runs reaching the final set are charged for addition but not final removal. It does not simply hide the unload card. The ending preference is included in shared links; older links still default to unloading.

## Exactness and limits

The default dynamic programme is exhaustive: it does not use a heuristic or complexity guard. The browser UI supports up to 50 sets, up to 4,096 input characters, up to six plates of each denomination in configured stock, total requested weights up to 1,000 kg, optional one-sided loading, monotonic stacks and an ordered pinned starting stack.

Plate-count vectors use collision-free mixed-radix state encoding. Dense state spaces use compact membership bitsets; larger direct-API calls retain an exact sparse representation. The interval search memoises one all-pairs cost table per prefix and contiguous block of sets. Repeated set weights share feasibility data, and impossible inventory branches are pruned without changing the search space or result.

Consecutive identical valid targets are collapsed before the interval search and expanded afterwards into separate zero-change rows. Weighted common-prefix distance is a tree metric, so replacing a run of identical feasible targets with one stack cannot increase either objective. Pinned starting states remain separate because their feasible set differs. Invalid annotations do not interrupt a physical run, and final cleanup stays on the final valid row.

The starting stack may exceed the selected stock count because those plates are already physically present. Its UI length is bounded to eight plates per denomination (56 total), including when an optimiser-produced stack becomes the start of a remaining-set plan. These are input validation bounds, not an approximation to the optimiser.

Long worker calculations expose Cancel and can be replaced by fresh input without accepting stale replies. A worker announces when computation begins; a runtime failure is reported rather than rerunning an expensive workload on the main thread. Browsers where workers cannot start use an exact synchronous fallback with a 3 s time budget, checked once per column of the interval search. Expiry aborts with an explicit message and returns no partial or approximate solution. Direct API callers can optionally supply the ninth argument `{ leaveLoaded, timeLimitMs }`; there is no deadline by default.

Warm-up targets must be exactly loadable with the selected bar, sidedness, stock and starting inventory. Intermediate sets are projected downward to the nearest loadable weight at or below each intended percentage, so a warm-up never exceeds its stated stage.

Monotonic mode preserves the declared physical starting-stack order. An incompatible stack is rejected rather than silently rearranged.

## Development

```sh
npm test
npm install
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The dependency-free Node suite covers the exact optimiser, state handling, worker and service-worker behavior, and deterministic build boundaries. Independent exhaustive-oracle tests cover open and closed endings, both sidedness settings, pinned starts, invalid rows, repeated targets and all three objectives. A subprocess regression budget protects the 50-repeat high-stock case.

The Playwright suite exercises the built app under the exact `/plateloader/` project path in desktop Chromium, mobile Chromium and mobile WebKit. It covers keyboard navigation, optional custom inventory, shared-state restoration, offline operation, ordered compact loading, scrollable wide stacks, workout progress, replanning, Undo, cancellation and stale worker replies. Unit tests run on both Ubuntu and Windows in CI. Mobile emulation does not replace physical iPhone installation, update and touch testing; the WebKit clipboard-feedback test uses a stub because the permission override is not available there.

The build is deterministic, single-writer, crash-recoverable and atomic. It writes `_site`, copies source assets without ad-hoc HTML/CSS/JavaScript rewriting, injects a content-only service-worker build ID, retries transient Windows rename failures, and leaves all source files readable. App-shell cache generations are immutable and isolated by the exact service-worker registration scope. Runtime cache failures degrade to network loading instead of discarding a successful response.

The worker-first runtime loads the exact optimiser on the main thread only as a fallback. A restrictive same-origin content-security policy keeps scripts, styles, workers, fonts and network requests inside the app. Each distinct font payload is stored once, and committed text files use LF so builds remain reproducible across platforms.

URL state is updated immediately while local storage is coalesced during typing and flushed when the page hides, so rapid reloads retain the latest input. Shared links carry all calculation settings, including optional per-denomination inventory, the terminal unload preference (`l=1` means leave loaded) and retained starting inventory (`a=`). Workout progress and previous warm-up target are local preferences rather than recipient state.
