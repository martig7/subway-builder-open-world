# Tile-switch follow-up and routing-result retention

Following the [September 20 OOM investigation](2026-09-20-blueprint-oom.md), the user confirmed a slow Chiba-to-Tokyo tile switch and a subsequent local calculation. The archived recorder explains why that later calculation was necessary:

| Event (EDT, September 20) | Time |
| --- | --- |
| Native destination navigation begins | 00:53:47.467 |
| Native save-loaded event | 00:54:30.256 |
| Outgoing Chiba off-tile calculation | 00:55:32.320–00:55:38.772 |
| Tokyo active preparation rejected by memory admission | 00:55:38.962 |
| Destination map attached; navigation complete | 00:55:51.283 |
| Later Tokyo preparation succeeds | 00:56:21.868–00:56:45.677 |

The handoff took at least **123.816 seconds**, excluding any earlier staging. More than 104 seconds elapsed before the first recorded mod native-demand job. The trace does not separate all native loading, topology restoration, routing, and mod handoff costs, so it cannot attribute those 104 seconds entirely to native routing.

The switch turns cached simulation off. Native destination loading and `refreshNativeCommutes()` use the base game's commute path, with a completeness check to skip unnecessary repair. The mod's Wasm preparation is a separate later operation. Tokyo preparation was refused before worker creation or demand serialization because combined allocations exceeded the admission budget. The later 23.809-second job was the first completed mod preparation for that state, not a second successful cache calculation. Inactive tile finance estimates cannot substitute for active assignments: the latter use loaded departure times and the full active network.

## Confirmed retention bug

Two long-lived queues used `tail = job.catch(...)`: the shared routing queue and the native-demand evaluator's private queue. A rejection-only handler forwards a successful result into its returned promise. Consequently, each idle queue kept its most recent profile/assignment result reachable even after the worker terminated and the caller released the result. Disposing an evaluator did not remove its private retained result.

Both queue barriers now resolve to `undefined` after success or failure while returning the original job promise to callers. Serialization, caller results, and failure recovery are preserved. The shared evaluator generation is incremented from 3 to 4 so hot reload replaces the previous queue closure.

The result is still retained when an actual consumer needs it. This fix removes unintended queue ownership; it does not make native assignment publication fully streaming or prove that the retained response accounted for the entire pre-crash heap growth.

## Verification

The isolated WeakRef/GC regressions failed before the fix: the idle shared queue retained its completed response, and idle/disposed evaluators retained both response and assignment objects after the shared queue was drained. They pass after the fix. A separate test checks serialized execution, unchanged return values, and recovery after rejection. The previous-generation replacement regression also passes.

**986 platform tests and 7 Japan consumer tests pass.** Forced collection is used only in isolated Node regression processes, never in the game. The exact routing algorithm and disk-cache schema are unchanged.

The selected consumer is `prototype/japan/mod`, manifest `local.japan-open-world`. Built and installed bundles contain `releaseRoutingJobResult` and evaluator generation 4, have matching timestamps and SHA-256 `200f0c4b3c509adb99aebc4cecd04a199dcc4542997d201e2f2de29823035172`, and the shared tile service returned HTTP 200 after installation.

Live mod reload reported evaluator generation 4 and replacement of the old evaluator. Tokyo remained paused with the same session, clock, balance, and station/route/track/train ID hashes (1,312 stations, 252 routes, 8,382 tracks, 1,046 trains). The new evaluator processed background jobs in the game. No tile switch or blueprint edit was performed during this verification.

At the final live check, all 36 workers started by the new evaluator had completed and been released, with no queued/active job and no live worker. Temporary verification globals were removed. An intervening native autosave stalled the renderer but completed successfully. The game log records native autosaves taking 151.780, 155.558, and 164.588 seconds before this fix, and 152.701 seconds during verification. That separate save stall is not resolved by discarding routing queue results.

A weak probe had not observed collection of the retired evaluator before cleanup. No in-game collection was forced, so this does not distinguish a remaining owner from delayed collection. Hot reload verification proves the new implementation is active, not that all previously retained state has been reclaimed. A full game restart provides a clean process for subsequent memory comparisons.

The precise contribution of this retained result to the OOM remains unmeasured. Old demand surviving tile retirement, native renderer publication peaks, and blueprint/map growth remain separate leads. This change is not a claim that the full slow-switch or OOM scenario is resolved.
