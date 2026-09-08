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

## Retired rendering resources: live check, 2026-09-08

Consumer: `prototype/japan/mod`, manifest `local.japan-open-world`; live bundle
marker `compact-native-load-diagnostics-v1`. This check changes no runtime code.

The first Tokyo-to-Kanagawa attempt crashed before transition completion and
before the requested post-switch collection. Chromium recorded another
`V8 javascript OOM (CALL_AND_RETRY_LAST)` at 14:13:58. Starting CDP heap used was
1,539 MB. The native reload guard recovered Kanagawa with all 316 stations and
53 routes. No heap snapshot was taken.

From the fresh renderer, forced collection reduced initial heap used from 623 MB
to 582 MB. Weak references were then attached to selected old resources; the
probe kept only weak references and scalar metadata. Kanagawa-to-Tokyo completed
in 27,374 ms. Eight seconds later, followed by explicit CDP collection, the
following old resources remained:

| Resource tracked before switch | Observation after collection |
| --- | --- |
| Native road GeoJSON, features, road RBush and root | All four remained; none was the current store object |
| Native runway GeoJSON and features | Both remained; neither was current |
| Old MapLibre map and style | Both remained; map marked removed |
| Old Deck instance | Remained; layer/event managers and animation loop disposed |
| Source caches | 12 of 15 remained; their active tile maps were empty |
| Active tile objects | 107 of 107 remained; this does not mean their payloads remained |
| Sampled MapLibre geometry buckets | 0 of 17 remained |
| Old road layers | 18 of 18 remained, marked finalized and awaiting collection |
| Road attribute ArrayBuffers | 40 remained, 19.33 MB total; two buffers totaling 1.95 MB were also used by current layers |
| Road GPU buffer wrappers | 18 remained, but all were marked destroyed; former allocation was 19.33 MB |
| Old minor-road tile source | Worker terminated, cache empty, notify callback cleared |

The tracked retired-only CPU backing buffers account for **17.38 MB**. Their
typed-array views are the same backing allocations and must not be added again.
This excludes object-heavy road geometry and the spatial index: their retained
sizes were not measured. Former GPU buffer sizes are not live GPU usage.

Repeated collections over several minutes, clearing console history, and a
camera update did not release these objects. Heap used stayed around 1,253–1,256
MB after collection. The difference from the initial Kanagawa heap cannot be
called the leak size: Tokyo has different live city data, and loading also
changes native and mod state.

This establishes retention of retired CPU resources, not its owning root or
unbounded growth. Bounded inspection of accessible mod globals and React fibers
did not find the owning reference. Closure inspection was stopped because it
required too much debugger work. The evidence does not justify indiscriminately
clearing native state or assigning the retention to a particular mod wrapper.
The next repair needs to locate the retaining owner and release its old-city
references; forced GC alone cannot collect reachable objects.

Tokyo, original camera, paused state, 316 stations and 53 routes were restored.
Temporary browser probes were removed. Diagnostic helpers and raw results remain
under the Git-ignored `.analysis/render-retention-*` prefix. No production fix,
new build, or performance speedup is claimed by this inspection.
