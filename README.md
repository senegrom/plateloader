# Plate Loader

Plate Loader finds an exact, globally optimal sequence of plate stacks for a list of deadlift sets. It runs entirely in the browser and can be installed as an offline-capable web app.

## Optimisation semantics

The available plates are 25, 20, 15, 10, 5, 2.5 and 1.25 kg. Stock is specified per side for symmetric loading and as a total count for one-sided loading.

The optimiser preserves the longest common inner stack between consecutive valid sets and minimises one of three lexicographic objectives:

- **Plate moves:** total plates added or removed; ties favour fewer kilograms handled.
- **Kilograms moved:** total plate mass handled; ties favour fewer plate moves.
- **Σ√kg moved:** the sum of square roots of individual plate weights handled; ties favour fewer plate moves. Because this cost is sublinear, it discounts heavier plates relative to the kilograms-moved objective and usually favours fewer, larger plates.

Invalid entries remain visible but are skipped as physical states, so valid sets on either side remain optimised together. The final valid set includes the unload back to the bare bar.

## Exactness and limits

The dynamic programme is exhaustive: it does not use a heuristic or complexity guard. The browser UI supports up to 50 sets, six of each plate type, total weights up to 1,000 kg, optional one-sided loading, monotonic stacks and an ordered pinned starting stack.

The starting stack may exceed the selected stock count because those plates are already physically present. Its counts are limited to keep the optimiser's compact state encoding valid.

## Development

```sh
npm test
npm run build
```

The build is deterministic and writes an atomic `_site` directory. It copies source assets without ad-hoc HTML, CSS or JavaScript rewriting, injects a content-derived service-worker build ID and leaves all source files readable.
