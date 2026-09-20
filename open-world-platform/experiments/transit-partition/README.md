# Transit partition experiment

This opt-in experiment asks whether graph partitions reduce the cost of routing
on a player's existing network. Nothing in the production consumer imports it.
It reuses the schedule-aware C++ search from `../commute-wasm`, compiled with
`PARTITION_EXPERIMENT`, and the existing platform `searchKernel` interface.

Connected cells are grown from station adjacency, independently of Tile Views.
For each cell, reverse multi-source Dijkstra precomputes an optimistic travel
cost from every station to any station in that cell. Ride costs exclude waiting
and dwell; walking uses the query's perceived walking multiplier. For a query
whose destination catchment spans several cells, the minimum of their tables is
used. Final egress is omitted from the bound. Actual searches still evaluate
departures, transfers, dwell, onboard state, access-only driving and fares.

Two variants deliberately separate pruning from changing search order:

- `partition-prune-N` retains the existing cost-first priority queue and skips
  states when their cost plus the lower bound exceeds the best known journey.
- `partition-astar-N` orders the queue by cost plus the lower bound as well.
  This can reach a useful upper bound sooner, but can also change equal-cost
  route selection. **Rejected:** the seed-7 regression changes route attribution,
  despite matching the complete Japan capture. It is excluded from the default
  variants and retained only to reproduce this negative result.
  Full-output parity is an acceptance gate for both variants;
  an admissible lower bound alone does not establish equivalence to this router.

`N` is the target maximum number of stations per cell. Fragmented/disconnected
graphs can produce more cells than `ceil(stations / N)`. This pilot uses an
O(cells * stations^2) preprocessing scan. It is not a HypRAPTOR implementation,
an exact timetable overlay, or a claim that this partitioner is optimal.

Tables are replaced whenever the router object or walking weight changes;
service/topology/World changes therefore rebuild them conservatively. The table
uses `stations * cells * 8` bytes, plus a bounded cache of 128 combined destination
tables and the existing Wasm scratch memory. No fine-grained invalidation is
attempted. Exhausting the existing Wasm scratch capacity invokes the platform's
JavaScript fallback.

## Reproduce

The checked-in `.wasm` is ready to use with Node 24 (the replay also validates
the native save's payload CRC). From the repository root:

```powershell
node --test open-world-platform/experiments/transit-partition/transit-partition.test.js
node --max-old-space-size=4096 open-world-platform/experiments/transit-partition/benchmark-save.mjs `
  --save=D:/SubwayBuilder/example.metro `
  --data-root=C:/Users/USER/AppData/Roaming/metro-maker4/cities/data `
  --output=.analysis/partition-results.json `
  --tiles=JP_PREF_12,JP_TOKYO_MAINLAND,JP_KANAGAWA_MAINLAND `
  --repeats=3
```

Omit `--tiles` to use the saved Tile View. `--limit=2048` selects evenly spaced
cohorts for a pilot. The default variants are `javascript,wasm,partition-prune-32`.
Explicitly adding `partition-astar-32` with `--variants` reproduces the rejected
candidate; passing the save replay does not override its known fixture failure.
`--drive-access=true` enables the separate
drive-to-station scenario; the default is false because this setting is not
stored in Native Saves. Remaining pathfinding settings use platform defaults.
`--save-outputs=true` writes complete diagnostic outputs beside the report;
keep these private files under ignored `.analysis`.

The replay reads the Native Save and installed demand packages without changing
them. It uses the current platform's full native-demand evaluator with assignments
for both travel directions, saved fare groups, and the saved network. It restores
saved departure times where available; other tiles use the evaluator's existing
deterministic departure generation. As in production native-demand evaluation,
the network uses configured service counts and removes live train phase anchors.

Each timed evaluation runs in a new Node worker and includes Wasm initialization,
graph packing, partition preprocessing, bounds preparation, routing, assignments,
and finance calculation. Save/package decoding, worker dispatch, output hashing,
and game result application are outside the timer. Variant order rotates between
repeats. The first JavaScript result is the per-tile baseline; full JSON outputs
are hashed after omitting only routing counters and derived cache keys. A parity
failure remains visible in the report and must never be treated as a valid
speedup. This is a saved-network CPU replay, not an in-game midnight measurement.

To rebuild with the same WASI SDK toolchain used by the earlier Wasm experiment:

```powershell
$env:WASM_CLANG = 'PATH/TO/wasi-sdk/bin/clang.exe'
node open-world-platform/experiments/transit-partition/build.mjs
```

The build uses `-O3`, disables floating-point contraction and fast-math
transformations, and imports no runtime functions. Compiler flags and the output
SHA-256 are printed by the build command.
