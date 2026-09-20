# Mode-choice experiment

`createFastModeChooser` keeps the production deterministic income generator and
counts identical decisions over sorted income ranges. Each mode has an affine
cost in income value. A whole range is counted only when conservative comparison
bounds certify a single winner; crossings and numerically ambiguous ties use
the original strict comparisons. The driving/transit/walking tie order and
`MIN_TRANSIT_CHOICE` adjustment are preserved.

Inject the helper into an experimental copy of `cross-tile-mode-choice.js`:

```js
import { createFastModeChooser } from '.../mode-choice.js';
const fastModeChooser = createFastModeChooser({
  incomeValueAt: (index, population, rules) =>
    incomeForPerson(index, population, rules) / rules.HOURS_WORKED_PER_YEAR / 3600,
});
```

Replace `chooseModesFromMetrics`'s body with
`return fastModeChooser.choose(population, rules, metrics);`. The old
`incomeValueDistribution` then has no callers, so its unbounded cache remains
empty. Do not supply that old cached distribution as this helper's provider.
The provider must depend only on the index, population, and the five income
fields represented by the cache key. Input populations must have a finite,
safe nonnegative rounded-up length.

The default retained typed-array budget is 8 MiB and 4,096 entries. Eviction
precedes replacement allocation. Native sorting can use temporary scratch
space, so this is a retained array budget, not a total-process memory guarantee.
Populations exceeding the budget stream through the original individual
calculation without allocating a population-sized array. `stats` reports cache
bytes/entries/hits, eviction, generated values, and how many passengers were
counted individually or by a uniform range. `clear()` releases retained arrays.

Validation:

```powershell
node --test open-world-platform/experiments/commute-speed/mode-choice.test.js
node open-world-platform/experiments/commute-speed/mode-choice-benchmark.mjs
```

The tests read the current source implementation as their oracle. They cover
3,000 randomized cases with the real noisy/clamped income model, fractional and
empty populations, unavailable modes, strict and near ties, unusual nonfinite
costs, minimum transit thresholds, income rule changes, cache eviction, and
oversize streaming. All three tests passed in the initial run.

A warm synthetic microbenchmark (5,000 queries per population) measured:

| Population | Existing loop | Range counts |
| ---: | ---: | ---: |
| 100 | 9.67 ms | 4.67 ms |
| 1,000 | 78.01 ms | 5.07 ms |
| 10,000 | 759.85 ms | 6.35 ms |

Those isolated ratios do not predict total calculation improvement. The root
agent's full Tokyo profile measured only about 0.225 seconds of mode-choice
self time in a 45.6-second evaluation. The bounded cache is useful for memory
control, but this candidate alone cannot deliver the desired total speedup.
