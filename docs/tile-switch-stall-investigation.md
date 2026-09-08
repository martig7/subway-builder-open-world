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

## Explicit rendering retirement, 2026-09-08

Implemented `tile-rendering-retirement-v3` in the Japan consumer. After staging
the native handoff and validating navigation, retire the outgoing road worker,
road/runway feature arrays and every old road-index node **before** asking the
router to load the destination. Native teardown remains responsible for GPU
destruction. Once the outgoing map is removed and its layers are finalized,
drop road-layer data, state, attribute and context references and the finalized
Deck instance's `props.layers`. Preserve objects still used by a current renderer.
The cleanup records counts/errors only, never the retired objects themselves.

Two details matter: RBush `clear()` replaces the root without emptying an
independently retained old root; Deck finalization destroys GPU resources but
leaves JavaScript layer references. Also, `getMap()` can temporarily return the
already removed map after its manager is destroyed. Cleanup handles that interval
and can enumerate finalized sublayers from retained Deck props.

The initial implementation waited for native load to reset the store. It cleared
old roads successfully, but the large Tokyo-to-Kanagawa direction still produced
OOMs. Moving retirement before router navigation allowed that direction to
complete. Earlier experimental failures recovered the full network through the
existing reload guard. No heap snapshot or production forced-GC hook was added.

### Live weak-reference verification

Three consecutive switches on the final runtime preserved 316 stations, 53 routes
and the paused state, with no renderer reload or cleanup error:

| Direction | Duration | Road features retired | Index entries retired | Post-collection JS heap |
| --- | ---: | ---: | ---: | ---: |
| Kanagawa to Tokyo | 27,288 ms | 302,951 | 304,478 | 1,061,983,852 bytes |
| Tokyo to Kanagawa | 24,745 ms | 489,131 | 490,779 | 912,245,960 bytes |
| Kanagawa to Tokyo | 26,659 ms | 302,951 | 304,478 | 1,063,383,580 bytes |

The first switch collected 140/155 tracked old CPU array views: surviving view
payload fell from 57.63 MB to 5.95 MB. On the second switch, the old map, style,
Deck instance, all six tracked native road/runway objects, all 130 tile objects,
all 47 road layers and all 110 CPU array views were collected. On the third,
the equivalent objects, 180 tiles, 63 road layers and 150 CPU array views were
collected. Backing ArrayBuffers can survive independently (including buffers used
by current layers); this is not a claim that every byte of rendering memory is
released. The first captured map's empty wrapper objects also remained alive.

Tokyo's collected heap changed by about 1.4 MB over the measured round trip.
These collection-assisted checks establish object release, not ordinary frame
timings or an exhaustive absence of leaks. A short run cannot rule out every OOM.
The 24.7–27.3 second transitions remain expensive; no robust speedup percentage is
claimed from different single-run conditions.

Validation: 698 platform tests and six Japan behavioral tests pass, including
retained index roots, deferred native teardown, active data preservation,
navigation validation ordering and previous-generation wrapper replacement.
The active and installed Japan bundle SHA256 is
`A60719B6620A0184F3E295D44002B67905D879DD1148B26CF9DEFCF3F15D5AE9`.
Raw results are in `.analysis/render-retirement-v3-*.json` (Git-ignored).

### Remaining failure without diagnostic collection

The additional round trip deliberately omitted both forced GC and the preceding
weak-reference harness's eight-second settling period. Tokyo to Kanagawa
completed in 23,352 ms with zero cleanup errors. The immediate return staged but
the renderer crashed. The native reload guard recovered Tokyo with 316 stations,
53 routes and pause preserved; its 52,562 ms recovered transition is **not** a
successful uninterrupted switch measurement.

Rendering retirement therefore passes its direct release checks, but does not
fully resolve the OOM. This run cannot distinguish delayed collection from
overlapping late native work or another loading allocation peak. The remaining
failure needs allocation/lifetime tracing around immediate repeated transitions;
do not call the five-attempt sequence crash-free or assume a fixed delay or
forced-GC requirement has been established. The raw unsuccessful normal-operation
run is `.analysis/render-retirement-natural-roundtrip.json`.

## Remaining peak and native collision-data retention, 2026-09-08

The next phase trace reproduced the OOM during **early native destination city
loading**, after live-save staging and successful outgoing rendering retirement.
The source was Tokyo. CDP reported 1,051,937,972 bytes of used JS heap initially,
1,305,424,868 during staging, and 1,370,570,736 after the native store changed to
Kanagawa with zero stations/routes. At that last readable sample, retirement had
released 489,131 road features, 490,779 index entries, 100 road layers and
91,364,032 bytes of CPU attributes, with no cleanup error. The target crashed
about 2.6 seconds later. Chromium recorded a V8 JavaScript OOM.

**1.37 GB is the last readable sample, not the peak or the heap limit.** The
allocation sampler could not return a profile before the renderer died. The
exact allocation responsible for the remaining peak is therefore still unknown.
This narrows the failure to loading after cleanup; it does not establish that
rendering caches are being serialized into the save. The planned settling-delay
comparison failed on its first switch, so it also does not isolate a safe delay.
Raw evidence is `.analysis/transition-peak-settle.jsonl` (Git-ignored).

The game bridge exposes a native window reload, but no JavaScript GC operation.
Clearing its HTTP cache would not collect the heap. Direct browser reload and
location navigation did not perform the required document reset in this host;
the native reload command did. Two exploratory native-reload handoffs restored
the full network without diagnostic collection.

### Rejected approaches

The full-renderer-reload experiment completed two consecutive switches in
29,659 ms and 40,610 ms, but the third crashed about 3.8 seconds after staging
finished/reload was requested. Native recovery restored the network. A new
document's early heap samples also still contained hundreds of megabytes from
the previous document. Therefore document reload is not a reliable substitute
for cleanup. The experimental implementation was preserved in Git and removed
from the delivered bundle. Raw results: `.analysis/transition-renderer-verification.json`.

The host overwrote the attempted `--expose-gc` launch option, and its main-process
inspection option did not expose the requested debugger endpoint. More
fundamentally, production must not depend on enabling GC. No forced-GC hook,
custom GC launcher, or installed game-file modification is shipped. Diagnostic
collection below distinguishes reachable data from uncollected garbage only.

### Native decode sizes and retained payload

Lightweight native-loader tracing measured these payloads, without a heap snapshot:

| Data | Tokyo compressed | Tokyo decoded | Kanagawa compressed | Kanagawa decoded |
| --- | ---: | ---: | ---: | ---: |
| Roads | 26,396,797 bytes | 163,165,999 JSON characters | 17,022,496 bytes | 103,432,109 JSON characters |
| Building collision index | 163,821,937 bytes | 487,978,628 bytes | 121,899,987 bytes | 367,008,180 bytes |

JSON characters are not retained heap bytes; parsing also creates an object
graph and index. The native gzip loader reads a compressed ArrayBuffer and
constructs a Response/decompression stream before materializing its decoded
result. Decode temporaries therefore overlap with existing city data. These
measurements identify substantial allocations, but do not isolate the fatal
allocation in the earlier OOM. Raw trace: `.analysis/native-load-trace.jsonl`.

A normal Kanagawa-to-Tokyo switch completed in 25,467 ms. Weak references to the
outgoing building detector, its `getBuilding` function, and native demand data
all survived subsequent diagnostic collection. Backing storage remained
1,092,274,602 bytes after collection. Bounded mod/React graph inspection and
native action-wrapper scope inspection did not locate the ultimate retaining
owner; an old detector shell remaining reachable is nevertheless sufficient to
retain every typed-array section through its methods' shared closure.

Retiring **only the old detector's methods** made its original method collectible.
After diagnostic collection, backing storage fell from 1,098,166,507 to
731,153,847 bytes: **367,012,660 bytes**, matching the 367,008,180-byte Kanagawa
index within about 4.5 KB of other activity. The detector shell and old demand
data remained reachable; Tokyo's current 3,448,574-building detector was unchanged.
Raw results: `.analysis/detector-retention.json`, `.analysis/detector-retire-result.json`.

### Delivered cleanup

`tile-rendering-retirement-v4` now retires the outgoing native building detector
alongside roads after a successful Native Save handoff and route validation,
before destination loading. It replaces the known native detector methods with
empty implementations that capture no old data, and zeroes its grid/count. This
releases the binary payload even when an old native state or detector wrapper is
still retained. It leaves the current detector and unknown/frozen implementations
untouched. No collision geometry is simplified, and no save authority changes.

The recovery checkpoint also suspends and drains any in-flight saved-file decode
before staging a tile handoff, preventing its timer from overwriting the new live
save. Failed/non-navigation staging resumes it; the native load resets its state.
The guard generation is `native-saved-reload-v5` with replacement coverage.

This makes reference retirement consistent, rather than prescribing when V8
must collect. Old native demand data and the ultimate old-state retaining root
remain separate investigation targets; the change is not a claim of zero retained
memory or an exhaustive fix for every loading OOM.

### Worker allocation missed by main-renderer measurements

The detector-only build completed Tokyo-to-Kanagawa in 25,248 ms, and its retired
detector method became collectible naturally. The second switch nevertheless
failed with `V8 javascript OOM (MarkCompactCollector: young object promotion
failed)`. Thus detector retirement alone did not solve the loading peak.

Browser-level CDP sampling of each page/worker, without snapshots or forced GC,
found a MapLibre worker peaking at **1,030,907,732 heap bytes** during a subsequent
successful Kanagawa-to-Tokyo switch. The main page separately peaked at
1,453,186,092 heap bytes. An outgoing native road-tile worker peaked at
421,261,380 bytes and then disappeared; this worker was disposed, not accumulating
across switches. Per-target peaks are not simultaneous process RSS or a proven
V8 allocation limit. Raw baseline: `.analysis/worker-memory-watch-v2.jsonl`.

The MapLibre worker held only the current map's source indexes. Its dominant
GeoJSON index was native `roads-source`: 489,131 Tokyo road features, 6,682,700
root points, and 49 index tiles. The sole layer consuming this source is the
native `road-labels` symbol layer, with `minzoom: 15.75` and a name-based text
field. Only **55,284 roads have nonempty names**; indexing the rest cannot draw
any text, even when road labels are enabled.

`native-road-label-source-v2` filters this label-only source before initial
MapLibre source creation and subsequent `setData` calls. It preserves named
feature identity, order, properties and coordinates. The native roads collection,
Deck rendering and collision index remain complete. It adds no input/output
cache, clears the filtered array after native source removal, skips unrelated
sources/worlds and observed non-label consumers, and supports wrapper replacement
on mod reload. It relies on the observed native `roads-source`/`road-labels`
contract; a future base-game consumer of that source needs reevaluation.

Live Tokyo verification reduced root points to **1,111,636 (83.4% fewer)** and
features to **55,284 (88.7% fewer)**. All 55,284 named features remained. Index
tile count stayed 49; counts of points across levels should not be interpreted
as retained byte measurements.

### Final live verification

Four consecutive normal tile switches passed with the final cleanup and label
filter installed, without forced collection or document reload:

| Switch | Duration | Main heap at completion | Backing storage at completion |
| --- | ---: | ---: | ---: |
| Tokyo → Kanagawa | 23,209 ms | 1,498,599,540 bytes | 682,470,903 bytes |
| Kanagawa → Tokyo | 28,779 ms | 1,453,965,584 bytes | 805,114,633 bytes |
| Tokyo → Kanagawa | 25,732 ms | 1,691,042,420 bytes | 695,801,475 bytes |
| Kanagawa → Tokyo | 29,653 ms | 1,485,726,900 bytes | 807,338,727 bytes |

The sampled MapLibre worker peak was **188,525,524 bytes**, down **81.7%** from
the earlier 1,030,907,732-byte sampled peak. Sampling is periodic and the runs
have different allocation/collection histories; this is not a precise isolated
retained-size or process-RSS comparison. Main-renderer allocations remain large.
The overlapping 23–30-second timings do not establish a loading-speed improvement.
Four successful switches improve the evidence for stability but do not prove
that every loading OOM has been eliminated.

All switches retained the same session, 316 stations, 53 routes, 2,294 tracks,
164 trains, exact entity-ID hashes, money, elapsed time and pause state. Each
retired detector lost its old method naturally; the destination detector remained
usable. Cleanup reports had no errors. The final Tokyo source retained all 55,284
named roads by exact object identity, with zero mismatches against the untouched
489,131-road native collection. The camera and paused state were restored.
The recovery checkpoint was no longer suspended (`waiting-for-native-save`), and
`typeof gc` remained `undefined`.

Raw evidence: `.analysis/transition-road-label-verification.json`,
`.analysis/worker-memory-road-label.jsonl`, `.analysis/road-label-final-check.json`.
These local diagnostics are Git-ignored. Final platform tests: **709 passing**;
Japan consumer tests: **6 passing**. One intermediate suite run hit an existing
millisecond-sensitive `snapshotCapture === 0` assertion; the full rerun passed.
The selected `prototype/japan/mod` consumer (`local.japan-open-world`) was rebuilt,
installed and reloaded. Both bundles contain `native-road-label-source-v2` and
SHA-256 `62056557B48964929AFA3CCC6CB5C32CA9461C4E776A417B3778E43BE47BB4E8`,
size 6,278,202 bytes, timestamp 2026-09-08 20:29:27 UTC. The PMTiles service
returned HTTP 200 with `native-pmtiles-directory-v4`. Runtime markers and reset
map diagnostics were checked after the final return to Tokyo.
