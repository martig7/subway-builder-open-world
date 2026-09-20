# Transit partition experiment on the latest Japan network

Measured September 19, 2026 (America/New_York). The experiment lives in
[`experiments/transit-partition`](../open-world-platform/experiments/transit-partition/README.md).
It is opt-in and is not imported by a production mod.

**Result:** conservative partition pruning reduced the combined median evaluator
time from 135.63 s with plain Wasm to 131.98 s, a **2.7% reduction**. It processed
37.3% fewer edges. This is a modest extra benefit; the larger improvement was
already obtained by the existing Wasm kernel. Keep partitioning experimental.
The aggressive A* candidate is **rejected** because a branching-network fixture
changes equal-cost route attribution, even though it matches this player's save.

## Results

Medians of three full evaluations per variant, including partition preparation:

| Workload | Current JavaScript | Plain Wasm | Partition pruning | A* (rejected) |
| --- | ---: | ---: | ---: | ---: |
| Chiba | 65.98 s | 32.86 s | 28.80 s | 31.07 s |
| Tokyo mainland | 121.40 s | 52.63 s | 52.11 s | 53.08 s |
| Kanagawa mainland | 94.44 s | 49.18 s | 47.78 s | 48.19 s |
| Combined pass | 267.89 s | 135.63 s | 131.98 s | 132.34 s |

The combined row is the median of each repetition's three-tile total, not the
sum of the three independent medians. Combined ranges were 241.44–290.36 s for
JavaScript, 126.99–140.88 s for Wasm, and 123.69–133.45 s for pruning. Pruning
reduced the total within each corresponding pass by 2.6–5.3%. Three samples and
visible timing variation do not establish a precise latency guarantee.

All **36 saved-network full-output hashes matched**. A separate drive-access-on
sample of 2,048 groups per tile also matched for JavaScript, Wasm and pruning:
**9/9 comparisons** across 6,144 groups. That sample was too small to amortize
partition preparation and was slower than plain Wasm; it is a correctness check,
not an additional speed claim. The initial tuning pilot tried cell sizes 16, 32
and 64 on 2,048 Chiba groups; it also showed preparation dominating small batches.

Across one complete pass, plain Wasm relaxed 184,577,922 edges, pruning relaxed
115,752,757 (37.3% fewer), and A* relaxed 98,336,845 (46.7% fewer). Pruning's table
preparation took approximately 0.18–0.26 s per full evaluation. Reduced search
work did not produce a comparable reduction in the complete evaluator's time;
this experiment does not isolate every remaining cost.

The seed-7 A* counterexample has seven changed journeys. Example `p6` keeps the
same perceived time (1,330.6754589682844 s), clock time (1,501 s), fare and mode
choice, but changes from `r0 → r1` to remaining on `r0`. Route attribution is part
of the acceptance contract. A dedicated regression records this rejection;
checking only trip cost or aggregate mode counts would have missed it. The
rejected variant remains available explicitly for reproduction and is excluded
from the benchmark's defaults.

Raw evidence: [full measurements](transit-partition-results.json),
[drive-access sample](transit-partition-drive-access-results.json), and
[synthetic A* counterexample](transit-partition-astar-counterexample.json).

## Network and workload

The selected consumer is `local.japan-open-world`, owned by `prototype/japan/mod`.
Its installed manifest and the Native Save's `JP_PREF_12` city identify the Japan
consumer. No game renderer was running during this experiment; these measurements
are read-only Node worker replays, not live game or midnight timings.

The latest save at selection was
`prototype_autosave_6cf0ad7a842042a6a01367d66f60b8c9.metro`, saved on September 19
at approximately 21:02 Eastern. It contains 1,300 stations, 252 route records,
8,330 tracks, and 1,046 trains. The existing profile compiler filters temporary
route children, producing 35 primary routes. The source Native Save supplies
the complete network and fare groups; no World Record supplies topology.

The full comparison covers 168,765 demand groups, evaluated in both directions:

| Tile View | Demand groups | Saved departure times restored |
| --- | ---: | ---: |
| Chiba (`JP_PREF_12`) | 56,322 | 56,322 |
| Tokyo mainland | 59,201 | 0 |
| Kanagawa mainland | 53,242 | 0 |

Demand geometry, population sizes and driving metrics come from the installed
Tile Packages. Other tiles use the native evaluator's deterministic departure
generation. As in production native-demand evaluation, configured service counts
replace live train counts and phase anchors are removed. Main timings use
platform-default pathfinding rules with drive-to-station access explicitly off;
this feature flag is not part of a Native Save.

## What the experiment changes

Station adjacency is divided into connected cells with a target maximum of 32
stations. Fragmentation produces 99 cells. For every cell, reverse Dijkstra
precomputes optimistic remaining travel costs to any station in that cell.
Waiting, dwell and destination egress are omitted from the bound. The actual
search still evaluates schedules, transfers, onboard state and perceived costs.
Destination catchments that span cells use the minimum across their cells.

The pruning variant retains cost-first queue ordering and skips states whose
cost plus the bound exceeds the current best journey. The A* variant also uses
that bound to order the queue. These are alternatives to compare, not two
optimizations whose gains should be added together. Both reuse the earlier C++
kernel through compile-time hooks; there is no second runtime implementation.

The bound matrix occupies 1,029,600 bytes, plus a bounded cache of 128 combined
destination tables. Graph or walking-weight replacement rebuilds it. Preparation
is included in the measurements. The implementation marker is
`transit-partition-lower-bounds-v1`.

## Measurement limits

Each variant runs in a fresh Node worker. The timer includes kernel initialization,
graph packing, partition preparation, the complete native-demand evaluator,
journey assignments and finance calculation. It excludes save/package decoding,
worker dispatch, result hashing and application to a live game. This evaluator
returns all assignments; it does not reproduce the production worker's incremental
assignment transport or disk-cache behavior.

Variant order rotates between repetitions. Comparisons hash the full results,
omitting only `routingStats`, `contextKey` and `evaluationKey`. Mode choices,
journey assignments, fare attribution and revenue remain covered. Matching these
cases does not prove parity for every possible network, especially equal-cost
choices affected by changed queue ordering.

The experiment makes no fine-grained invalidation claim: topology, service, World
or walking-weight changes conservatively rebuild its tables. It is a partition
lower-bound experiment, not a timetable overlay or an implementation of HypRAPTOR.
No production bundle, service, Native Save or game setting was modified.

## Validation and reproduction

- Platform suite: **958/958**.
- Japan consumer suite: **7/7**.
- Wasm and partition experiment suites: **8/8**, including the explicit rejection
  regression. Pruning parity covers 25 seeded branching networks, explicit
  departure phases, midnight schedules, transfers, driving access, warm caches,
  graph/service/rule/World replacement, disconnected targets and scratch fallback.
- The final compiled partition module is byte-identical to the measured module:
  SHA-256 `254c44bf178834301556f40c850a9c9128f1157a7ba1368b372d30a375ea15db`.
- Compiling without the partition flag reproduces the original Wasm control:
  SHA-256 `09934501602cd20490271c837a24d89ee8baec43cd47a2f958f7f5c4267157e6`.
- The Native Save's payload CRC and before/after SHA-256 checks passed.

The private Native Save and three demand packages are archived locally under
Git-ignored `.analysis/transit-partition-inputs`. To repeat the accepted variants:

```powershell
node --max-old-space-size=4096 open-world-platform/experiments/transit-partition/benchmark-save.mjs `
  --save=.analysis/transit-partition-inputs/network.metro `
  --data-root=.analysis/transit-partition-inputs/cities `
  --output=.analysis/partition-repeat.json `
  --tiles=JP_PREF_12,JP_TOKYO_MAINLAND,JP_KANAGAWA_MAINLAND --repeats=3
```

The replay uses current platform source, with baseline commit
`a6ab3bb` at the start of this experiment. The linked README describes compilation
and how to explicitly reproduce the rejected A* candidate. No consumer build or
installation is needed to run this standalone experiment.
