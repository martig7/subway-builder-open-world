# Commute calculation: speed with bounded memory

Measured September 19, 2026 (America/New_York), using the latest captured Japan
Native Save: 1,300 stations, 252 route records, 35 primary routes. Three delegated
experiments investigated aggregation, mode choice, and approximate route reuse;
a second iteration added evaluation-scoped preparation and combined the winner
with conservative partition pruning.

**Result: the selected combination took 24.92 seconds, versus 114.87 seconds for
plain Wasm in the same streaming harness and memory configuration—approximately
4.6× faster, or 78% less calculation time.** The largest improvement came from
removing repeated finance aggregation. Approximate routes were unnecessary.
Every selected-combination assignment and finance-profile digest matched Wasm
on the measured inputs. This is experimental code, not an installed mod change.

## Controlled results

Both matrices use two repetitions per variant, with variant order rotated.
They cover all 168,765 cohorts in Chiba, Tokyo mainland and Kanagawa mainland,
evaluated in both directions. Each calculation runs in a fresh process, serially.
Values are medians in seconds; combined values use each repetition's total.

| Full evaluator | Chiba | Tokyo | Kanagawa | Combined | Maximum process RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain Wasm | 28.57 | 45.83 | 40.47 | **114.87** | **208.45 MiB** |
| Wasm + incremental aggregation + bounded mode choice + scoped preparation | 6.66 | 12.27 | 9.27 | **28.21** | **212.62 MiB** |

The second matrix retests the optimized control before adding partition pruning:

| Full evaluator | Chiba | Tokyo | Kanagawa | Combined | Maximum process RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Optimized control | 6.53 | 12.33 | 9.24 | **28.10** | **208.16 MiB** |
| Above + conservative partition pruning | 5.75 | 11.00 | 8.17 | **24.92** | **212.81 MiB** |

The two best-combination passes took 24.83 and 25.01 seconds. The original Wasm
passes took 115.52 and 114.22 seconds. The optimized control's repeat measurement
(28.10 versus 28.21 seconds) supports comparing the two matrices, but these are
small samples and do not establish a live-game latency guarantee.

Raw measurements: [main comparison](commute-speed-memory-results.json),
[partition combination](commute-speed-partition-combination-results.json).
The harness streams assignments; the earlier partition benchmark retained them.
Its historical 135.63-second Wasm result is not this experiment's control.

## Why the combination works

A diagnostic full-Tokyo CPU profile with plain Wasm took 45.61 seconds. Approximately
28 seconds of sampled time were in completed-commute aggregation, route signatures
and their hashes; approximately six seconds were in Wasm traversal. Profiling is
kept separate from the unprofiled comparisons above.

1. **Incremental aggregation** keeps bounded hourly groups as batches arrive.
   It avoids rebuilding and rehashing all previous records after each 128-cohort
   batch. It preserves rounding, stable order, existing overflow behavior and
   route attribution. Finalization produces ordinary arrays and releases the
   extra grouping metadata. The Tokyo run materialized 24 hourly arrays and
   observed at most 2,050 retained groups per hour under the existing cap policy.
2. **Scoped preparation** serializes the immutable network once and builds its
   fare index once per evaluation. Tokyo reduced 926 graph-key calls to one
   serialization and 131,097 fare-index requests to one build. No journey cache
   is added. Scope cleanup releases its references even on failure.
3. **Bounded mode choice** counts identical decisions over sorted income ranges,
   falling back to individual comparisons at ambiguous boundaries. Its income
   cache has explicit 8 MiB and 4,096-entry limits. Oversized distributions are
   streamed. This was a small timing component; bounded retention is useful.
4. **Conservative partition pruning** now removes 11.3% of the remaining total
   time. It retains the original queue ordering and schedule calculations. The
   table and bounded destination vectors add modest memory. This is the earlier
   conservative experiment, not the rejected A* ordering variant.

## Memory and approximation decisions

No extra concurrent compute workers were introduced. Calculation uses one process
at a time, small assignment batches, bounded caches, and job-scoped preparation.
Final tests set Node's old-generation limit to 128 MiB and its young-generation
semi-space size to 8 MiB. These are **not total-process limits**: measured RSS also
includes other V8 spaces, Wasm, native allocations, code and stacks.

The selected combination's maximum RSS was roughly 4 MiB above the main Wasm
control, rather than multiplying graph and demand replicas across a worker pool.
Between-batch sampled heap use peaked around 117 MiB; sampling can miss transient
peaks. OS peak RSS is the stronger process-memory measure reported in the tables.
The parent input-preparation process and the live game's renderer are outside
these child-process figures. This experiment does not reproduce or fix the
game's occasional OOM crashes, and Node GC settings are not automatically applied
to the game.

An initial exploration used a larger heap and retained compact error-measurement
rows. It measured 105.59 seconds for Wasm, 37.05 for aggregation plus mode choice,
and 33.48 with approximate route reuse. Do not compare that stage's 402–452 MiB
RSS directly with the final memory figures: GC settings and measurement retention
changed. [Exploration measurements](commute-speed-exploration-results.json).

Route reuse was rejected. Its extra 3.57-second saving changed revenue by -1.649%,
transit share by -0.538 percentage points, and produced very large journey-cost
outliers (maximum positive difference 26,577 perceived seconds). Its retained
menus were bounded, but it increased measured RSS. Exact schedule replay did not
make its selected route close to the best one. Detailed rejection and error
denominators are in the [route-reuse notes](../open-world-platform/experiments/commute-speed/route-reuse-notes.md)
and [error summary](commute-speed-exploration-summary.json).

## Validation, scope and reproduction

- Main and partition-combination matrices: all assignment and full profile
  digests match their controls; the controls also match each other across stages.
  Hashing excludes only routing diagnostics and context/evaluation cache keys.
- Driving access enabled: 2,048 sampled groups per tile, all three tiles,
  baseline and selected combination; **6/6 hashes match**. These small samples
  are correctness checks, not the source of the speed claim.
- Platform **958/958**, Japan consumer **7/7**, and Wasm/partition/new experiment
  tests **29/29**: **994 passing tests**. Coverage includes overflow/rounding,
  exact income decisions, fare policies, scope cleanup, graph replacement,
  schedules, driving access and the known rejected approximation cases.
- Input snapshot CRC and before/after SHA-256 checks pass. The source snapshot is
  `.analysis/transit-partition-inputs/network.metro`, archived from the previously
  selected latest Japan save, with SHA-256
  `4289787818d51014cb53943aec7a3affab7ddb68eac98efe3d2e2c3b13a2a957`.
  No Native Save, service, game setting or installed bundle was changed.

The final timer includes kernel/graph preparation, the full evaluator, aggregate
finalization and profile serialization. It excludes input loading, process
startup, assignment hashing, file writes and applying results to the game.
Main runs use default routing rules with driving access explicitly disabled;
saved Chiba departures are restored, and other tiles use deterministic generated
departures. The full comparisons preserve journey assignments, fares, revenue,
mode counts, hourly ledgers and route attribution for these inputs, not a proof
for every possible network.

Code and commands are in the [experiment README](../open-world-platform/experiments/commute-speed/README.md).
All substitutions are applied to private bundles, leaving production source
unchanged. The runnable consumer remains **`local.japan-open-world`**, owned by
**`prototype/japan/mod`**. Production integration still needs explicit job-owned
state across asynchronous worker batches, bounded lifecycle cleanup, consumer
build/install and live renderer verification. The experiment's synchronous memo
scope must not span a mutable game session or be naively wrapped around an async
worker job.
