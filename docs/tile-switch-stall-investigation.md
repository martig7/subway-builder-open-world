# Tile-switch stall investigation — 2026-09-08

Active consumer: `local.japan-open-world`, built from `prototype/japan/mod`.
Branch: `codex/tile-switch-stall`.

## Confirmed failure and memory fix

Chromium logging captured `V8 javascript OOM (CALL_AND_RETRY_LAST)` on
2026-09-08 at 13:39:12. The renderer exhausted its JavaScript heap, despite ample
system RAM. `performance.memory` reported a roughly 3.76 GB heap limit; its used
heap values were stale, so subsequent measurements use CDP Performance metrics.

The load-history ring retained `pendingTransition.nativeSnapshot` through
`summarizeWorldForLoad`. Two completed switches left two full native saves alive,
each containing 53 routes, 2,294 tracks, 38,439 financial-history entries and
32,243 completed commutes. Three diagnostic runtime views also retained complete
finance ownership baselines. These payloads are unnecessary for diagnostics.

Transition summaries now copy only identifiers and status. Lifecycle diagnostic
views use a dedicated compact accessor without copying the finance baseline.
The regression completes a real staged transition and proves its telemetry no
longer references the native handoff. It also verifies that the compact accessor
does not traverse the finance ownership baseline.

## Reproduction

Live Japan regional save, paused, 316 stations, 53 routes, Tokyo initially active.
A scripted call to the actual geographic overlay tile-click handler selected Kanagawa.
The first attempt completed, retaining the network. The 65-second CPU capture included
about 4.14 seconds in garbage collection and multiple full snapshot copies.
The completion trace included roughly 3.3 seconds building the destination projection
and 3.6 seconds restoring native state. This did not reproduce the user's exact failed
click; it did establish a large transition cost.

Returning to Tokyo after mod reload caused a renderer reload and an empty network.
Restored a completed Tokyo save, then repeated the pair after a fresh renderer load.
Tokyo to Kanagawa completed in 32,491 ms (staging 6,442; navigation 8,339;
completion 17,710). The return stalled and the game renderer exited. A surviving CDP
target stopped answering evaluation and debugger-pause requests. No actionable crash
stack or crash dump was obtained. Native MapLibre errors about null `type` also
occurred on successful switches and are insufficient to assign the failure.

## Delivered copy improvement

Snapshot assembly cloned all old save data before overwriting it with replacement
state. It also cloned old topology before overwriting it with the canonical network.
Clone only retained non-network fields and the save header, keeping output isolation.
No additional cache was introduced.

Regression command:
`node --test --test-name-pattern='native snapshot composition' prototype/kc-two-tile/mod/test/network-projection.test.js`
Before: failed, financial history read twice instead of once.
After: passed, history copied once, discarded topology never traversed, resulting
history/topology/header remain isolated from inputs.

Synthetic benchmark: 100,000 financial-history rows, 20,000 tracks, four iterations.
Before mean 317.01 ms; after mean 148.05 ms (53.3% reduction, 2.14x throughput).
This measures snapshot composition, not whole tile-switch duration.
The second live CPU capture recorded about 3.29 seconds GC, but single captures with
different native loading work are not enough to claim an end-to-end speedup.

Validation: 686 platform tests and 6 Japan tests passed.
Built and installed bundle SHA256:
`32E5B01A387411B9C8325FD33A7FB4FADE085BA1A7BA74673DCF00224583420F`.
Unique marker: `cloneNonNetworkState`; present in both bundles and the live CPU profile.

## Final live verification

Active marker: `compact-native-load-diagnostics-v1`. After a fresh renderer load,
Tokyo to Kanagawa completed in 28,009 ms and the return in 32,446 ms. Both retained
316 stations and 53 routes, stayed paused, and left **zero full native snapshots
and zero finance baseline views in diagnostic history**. The original Tokyo camera
was restored. The renderer remained responsive through the following autosave.

Final validation: 687 shared tests plus 6 Japan consumer tests passed. Built and
installed bundle hashes match:
`59516015E60E6A29BD279F45C1203317F03A781DE66533A5631930C6536CCF8F`.
PMTiles health returned HTTP 200 with `native-pmtiles-directory-v4`.

Lightweight allocation sampling covered the round trip without a heap snapshot.
CDP JS heap used went from 775 MB to 1,383 MB over the capture; this includes new
native city data and allocations not yet collected, and is not a retained-size
census. Largest sampled surviving allocation sites included native `loadData`
(137 MB), road-index construction (127 MB plus 66 MB), road tile unpacking
(47 MB), and mod snapshot stripping (32 MB plus 28 MB). These are sampling
estimates, not exact cache sizes.

The confirmed diagnostic retention bug is fixed. This short run cannot establish
that every potential source of heap exhaustion is gone. Native loading, snapshot
restoration and commute refresh still make complete tile switches take roughly
28–32 seconds; no substantial end-to-end speedup is claimed.
Raw CPU profiles, exception capture, benchmark output and baseline camera are in the
Git-ignored `.analysis/tile-stall-*` artifacts.
