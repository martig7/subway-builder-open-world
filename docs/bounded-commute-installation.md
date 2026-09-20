# Bounded commute runtime promotion

The exact combination from [the performance experiment](commute-speed-memory-experiment.md) is now the production backend for native-demand and cross-tile calculations: Wasm search with conservative partition pruning, incremental finance aggregation, bounded mode-choice lookup, and per-job graph/fare preparation. Approximate route reuse is excluded.

The runnable consumer is `prototype/japan/mod`, manifest `local.japan-open-world`, release 0.6.0. Its rebuilt bundle and installed bundle have SHA-256 `37cb63a4bcff04d501840d1477b8f965e82df4c892ebc951b7a9d096d6390009`. Both contain `bounded-commute-routing-v1` and `open-world-native-demand-worker-evaluator-v4-bounded`. The installed bundle timestamp matches the build. The shared map service returned HTTP 200, `native-pmtiles-directory-v4`, and `stored-driving-routes-v1` after installation.

## Verification

982 platform tests, 7 Japan consumer tests, and 29 experiment tests pass. Coverage includes JavaScript fallback, graph/service invalidation, worker transport, disk-cache replay, hot-reload wrapper replacement, and cleanup on completion, cancellation, and failure. Historical mode-choice tests use an independent frozen pre-promotion oracle.

After installation, Subway Builder was relaunched through its diagnostic launcher and resumed the user's latest Chiba autosave. The live game reported 1,300 stations, 252 routes, the new worker/kernel markers, and cached-simulation wrapper generation 16. A fresh uncached calculation sampled 2,048 of the loaded save's 56,322 cohorts against its full live network: 877 outward searches used Wasm, zero fell back, and the calculation took 0.453 seconds. The shared evaluator had completed and released all 37 workers it started, with zero queued/active jobs afterward. This small live probe confirms execution and cleanup, not a full-network timing estimate. [Live diagnostic evidence](bounded-commute-live-worker.json) records the result. The game remained paused, with its clock, balance, station count, and route count unchanged; its existing simulation-mode setting was preserved.

The actual production worker was replayed against the saved Japan network used in the experiment: 1,300 stations, 252 route records, and 168,765 demand cohorts across Chiba, Tokyo mainland, and Kanagawa mainland. Every assignment hash and finance/profile hash matches the original Wasm control, both after calculation and after compressed disk-cache replay. Profile comparison excludes only diagnostic statistics and cache keys. All searches used Wasm without fallback.

| Tile | Fresh worker job | Disk replay | Cohorts |
| --- | ---: | ---: | ---: |
| Chiba | 10.99 s | 3.00 s | 56,322 |
| Tokyo mainland | 20.12 s | 5.49 s | 59,201 |
| Kanagawa mainland | 15.92 s | 4.69 s | 53,242 |

These end-to-end verification times include decoding, output hashing, compression, and filesystem cache writes. They are not directly comparable to the experiment's 24.92-second compute-only total, which was about 4.6 times faster than its equivalent plain-Wasm control. Each tile ran in an isolated process with a 128 MiB old-generation limit and 8 MiB semi-space. Peak process RSS across fresh jobs and subsequent replay was about 246 MiB. [Raw production replay results](bounded-commute-production-results.json) retain timings, hashes, and cleanup diagnostics.

## Memory behavior

The accelerator caps Wasm linear memory at 32 MiB, partition tables and vectors at 8 MiB, and mode-choice lookup at 8 MiB. It falls back to the existing exact JavaScript search for unsupported graphs or exhausted scratch capacity. Existing routing cache and batch-size limits remain in effect; no additional parallel workers were introduced.

On the saved network the Wasm allocation peaked at 11.25 MiB. After each job, current Wasm storage, retained graph edges/states, partition storage, and income lookup storage all report zero. Cleanup also covers early generator return and exceptions. These are accelerator bounds, not a cap on the entire game process; the installation does not establish that all causes of game OOM are fixed.
