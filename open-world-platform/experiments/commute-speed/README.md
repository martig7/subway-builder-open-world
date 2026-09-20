# Commute speed and memory experiments

Standalone experiments against the latest captured Japan Native Save. Production
does not import these modules, and the harness does not install a mod or write a
Native Save. The target consumer is `local.japan-open-world`, built from
`prototype/japan/mod`. Its live renderer is not required for these CPU replays.

The baseline is the existing Wasm kernel. The experiment combines independent
changes without editing runtime source: esbuild applies checked substitutions
only to private bundles under the requested output directory.

| Variant token | Change |
| --- | --- |
| `wasm` | Existing packed C++ search, unchanged |
| `aggregate` | Incremental bounded completed-commute grouping; preserves each batch's rounding, order, and overflow behavior |
| `modes` | Exact income-range counting with a bounded cache instead of an unbounded income distribution cache |
| `memo` | One network serialization and fare-index compilation per immutable evaluation snapshot |
| `reuse` | Approximate reuse of route candidates; rejected for poor error/speed tradeoff |
| `partition` | Conservative 32-station partition lower-bound pruning using the earlier experimental kernel |

Tokens combine, for example `wasm-aggregate-modes-memo`. No process pool is added.
The parent starts only one calculation process at a time. Assignment data is
hashed and discarded per batch rather than retained for a whole tile. The
completed finance profile remains bounded by the existing aggregation policy.

Run from the repository root:

```powershell
node --expose-gc open-world-platform/experiments/commute-speed/benchmark.mjs `
  --variants=wasm,wasm-aggregate-modes-memo --repeats=2 `
  --heap-mib=128 --semi-mib=8 --output=.analysis/commute-speed-repeat
node open-world-platform/experiments/commute-speed/summarize.mjs .analysis/commute-speed-repeat
node --test "open-world-platform/experiments/commute-speed/*.test.js"
```

Defaults read `.analysis/transit-partition-inputs/network.metro` and its archived
`cities` directory. These private player inputs are Git-ignored. Override with
`--save=...` and `--data-root=...`. The default tiles are Chiba, Tokyo mainland,
and Kanagawa mainland. `--limit=4096` selects a deterministic evenly spaced pilot;
omit it for all 168,765 cohorts. Saved Chiba departures are restored from the
Native Save; the other tiles use the evaluator's deterministic departures.
`--drive=true` enables driving access for a separate correctness replay.

`--heap-mib` sets Node's old-generation limit, not a total-process cap.
`--semi-mib` sets its young-generation semi-space size. RSS also includes young
generation, Wasm memory, code, native allocations, stacks, and input parsing.
Each row reports OS peak process RSS and memory sampled between batches; heap
samples can miss transient allocation peaks. These are isolated compute-process
measurements, not a measurement or cure of the game's OOM crashes.

The timer includes evaluator work, kernel/graph preparation, finalization of
lazy aggregate arrays, and final profile serialization. It excludes save/demand
decoding, process startup/dispatch, assignment hashing, file writes and game
application. This streaming harness differs from the earlier partition benchmark,
which retained all assignments. Compare variants within the same harness and
settings; do not directly divide timings from different experiments.

`--metrics=true` additionally collects compact per-cohort outcomes for error
analysis. This adds retained measurement memory, so final memory comparisons
must omit it. `--profile=true` saves a private CPU profile and function sample
summary; profiled timings are diagnostic and must not be mixed into speed claims.

Exact variants are compared by assignment and full profile SHA-256 digests.
Profile hashing omits only `routingStats`, `contextKey`, and `evaluationKey`.
The profile digest still covers finance, revenue attribution and hourly ledgers.
Input CRC and before/after Native Save hashes are checked. Approximate variants
require error analysis; their digests are expected to differ.

The memo scope requires immutable inputs and ends after one synchronous job,
including on failure. Never attach it to a mutable game store or a worker's
entire lifetime. Incremental aggregation must be finalized to ordinary arrays
before exposing results to arbitrary consumers. Its route arrays are immutable
during accumulation. Any production integration must preserve these boundaries,
bounded caches, streaming assignment transport and generation-safe invalidation.

See the report in `docs/commute-speed-memory-experiment.md` for the measured
combination, memory results, rejected approaches and validation.
