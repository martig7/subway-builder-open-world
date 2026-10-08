# Japan map interaction and memory audit

Profiled the existing debug game on 2026-10-07 with three subagents auditing
interaction paths, memory ownership, and profiling protocols. Japan
(`local.japan-open-world`, consumer `prototype/japan/mod`) was active in Hyogo
(`JP_PREF_28`), with 1,462 stations, 277 routes, 9,324 tracks, and 372,646 roads.
The game remained paused with cached Ultra enabled. Other loaded mods included
Improved Schematics and Game Speedup; attribution distinguishes their/native
work from Open World's wrappers.

The largest ordinary zoom stalls come from native station-marker rebuilding.
The strongest retained-memory growth comes from the native minor-road worker.
This change removes unnecessary offscreen ribbon allocations in Open World;
it does not resolve either larger native problem.

## Method and reproduction

Used the existing Chromium debugger on port 9222. Unprofiled captures measured
requestAnimationFrame gaps, Long Tasks, render/movement events, and tile arrivals.
Separate short CPU/trace captures supplied stack attribution and GC events.
Scalar CDP heap readings covered the main isolate and six related worker
isolates, deduplicated by isolate ID. No live forced GC or full heap snapshot was
used. Read-only buffer and closure censuses supplied ownership lower bounds.

The repeatable local commands are:

```powershell
node .analysis/perf-interactions.mjs .analysis/perf-baseline-a
node .analysis/perf-interactions.mjs .analysis/perf-zoom-repeat --kind=zoom
node .analysis/perf-interactions.mjs .analysis/perf-zoom-cpu --kind=zoom --profile
node .analysis/perf-input-gestures.mjs .analysis/perf-input-baseline --zoom=13.5
node .analysis/perf-isolate-census.mjs .analysis/perf-isolates-before.json
node .analysis/perf-roadworker-index-census.mjs
```

The interaction harness fails when interaction p95 exceeds 33.4 ms or a frame
gap exceeds 100 ms. This is a responsiveness target, not a GPU FPS measurement.
The first full run and the minimized zoom repeat both failed. Short captures
include natural GC and cache-order variation; a single p95 is not a sustained
performance guarantee. Native running-mode simulation and complete GPU memory
were not profiled; these captures establish costs that exist even while paused.

Camera origin: longitude 135.528048604466, latitude 34.70547018342327, zoom
11.57493512829012. Pan tests use zoom 14; zoom tests sweep 13.5–14.5. Original
camera, layers, pause state, and the settings panel were restored. Mod reload
reset the camera to the prefecture center; those initial after-reload captures
were excluded from matched-location comparisons and the original location was
restored before repeating them. One input attempt safely aborted when no clear
canvas segment was available; the subsequent matched attempt completed.

## Live interaction results

The original unprofiled scenario was repeated after installing the change,
at the same location with the same layer settings.

| Gesture | Before p95 / maximum, ms | After p95 / maximum, ms |
| --- | ---: | ---: |
| Idle | 13.4 / 16.7 | 13.4 / 16.6 |
| Pan | 20.0 / 46.6 | 23.2 / 23.4 |
| Zoom | 143.4 / 216.7 | 126.6 / 186.8 |
| Pan and zoom | 119.9 / 700.0 | 130.0 / 663.3 |

Zoom still fails the responsiveness target. Both builds produced long frames;
the table does not establish an overall speedup. The minimized original zoom
repeat had p95 136.6 ms and maximum 473.3 ms. Real mouse-wheel bursts reproduced
100–197 ms gaps; real drags were generally cheaper, with occasional long gaps.

Ranked hypotheses were tested against these observations:

1. **Minor-road zoom-band clipping:** weakened as the main explanation. A sweep
   entirely above zoom 14 had p95 146.6 ms; hiding roads and bridges yielded
   163.3 ms. The threshold is not necessary for the stalls.
2. **Native marker model rebuilding:** strongly supported. Hiding both station
   dots and labels reduced p95 to 36.7 ms, although two long frames remained.
   Hiding labels alone would not isolate this path.
3. **Native tile/GPU processing and GC:** confirmed contributors. A matched
   after-capture had a 663 ms frame overlapping substantial incremental marking,
   MapLibre receive work, and native Deck buffer/model work. These overlapping
   trace events must not be summed as independent pauses.
4. **Stale rail-cache comparisons:** not supported in this capture. Live
   `legacyGeometryComparisons` stayed zero, and the current CPU capture did not
   reproduce the historical recursive-comparison hotspot.
5. **DOM marker movement/style listener loops:** not leading costs. Normal
   station display uses Deck markers; DOM edit markers were not the active path.
   The instrumented style-data work was small.

### Native station-marker cost

In the original 3.03-second profiled zoom, stack attribution estimated 772 ms
in the native station-marker model/route-group path. The four worst ordinary
frames spent about 115–131 ms in this path, versus 16–23 ms in Open World's
Portolan clipping. Inclusive function totals overlap; ownership categories are
sampled estimates.

Current installed game source `GameMain-DSzNxHOd.js` shows:

- `AllStationMarkers` (line 83887) rebuilds its model on each zoom tenth.
- `buildMarkerModel` (line 83622) repeatedly resolves route groups for station
  importance, dot colors, and route bullets.
- `getOrderedRouteGroups` (line 14685) rebuilds full-network color groups on
  every call, even though routes did not change.

The highest-value CPU fix is to prepare route ordering/membership once per
route/topology revision, then separate stable marker topology/importance from
zoom-dependent sizes and collision placement. Keep one current topology cache
and invalidate edits, route styling, selections, and themes correctly. These
private native functions have no ordinary mod replacement API. Downstream
Open World clipping cannot prevent their earlier construction.

## Memory ownership and growth

One pre-change scalar census reported:

| Owner/measurement | Size |
| --- | ---: |
| Main-isolate JS used | 1,729 MiB |
| Main-isolate backing storage | 853 MiB |
| Six worker JS heaps combined | 686 MiB |
| Native minor-road worker JS used | 534 MiB |
| Largest blob worker JS used (ownership not independently classified) | 147 MiB |
| Building detector's shared backing buffer | 187 MiB |
| Unique reachable general-map tile buffers, lower bound | 137 MiB |
| Renderer process private memory | 4.04 GiB |

Heap, backing storage, process private memory, and GPU/native allocations are
different measurements. Do not add the ownership rows to the totals: several
are subsets, and backing pages can be shared across isolates. The current
instance did not expose a verified heap limit/headroom measurement. These
numbers cannot establish crash-free capacity for another road package.

### Native road-worker retention

The renderer's `RoadTileSource.cache` is capped at 256 entries. Its worker's
GeoJSONVT `index.tiles` and `tileCoords` retain visited descendants independently
of that cap. The existing Open World MapLibre dormant-cache budget does not
bound this separate native worker.

Six live pans at zoom 14.5 increased worker tiles from 257 to 405 and used heap
from 534 to 629 MiB: about 95 MiB growth. Repeating the route left 417 tiles and
573 MiB used after natural GC. The persistent tile graph is growing; heap use
also fluctuates with temporary allocations. This is not evidence of identical
growth on every repeated gesture.

An isolated replay of the *current native worker* with Hyogo's 346,205 minor
roads/2,399,777 vertices grew from 29 tiles and 199 MiB retained JS heap to
661 tiles and 966 MiB after 500 tile requests across five centers and zooms
11–14. Retained growth was 767 MiB after isolated Node GC. This is a retention
stress test, not live frame timing. Local reproduction:

```powershell
node --expose-gc .analysis/perf-native-roadworker-replay.mjs
```

A bounded worker index is the largest identified memory fix. Eviction must keep
the source/ancestor data needed to regenerate children; blindly deleting
GeoJSONVT tiles can break subsequent loads because drilling clears parent
sources. Validate returned tile equivalence, boundary geometry, repeated
evict/revisit cycles, retained-memory bounds, and cold-miss latency. A renderer
cache cap alone is insufficient.

### Other retained data

Package preparation/current-package caches contain manifest descriptors, not
a second complete road collection. Existing road-label compaction, retired
road/building cleanup, rail revisions, and MapLibre dormant-cache caps are
already implemented; historical recommendations for these are not new fixes.

The mod's active tile bookmark retains an independent copied financial history
with 117,343 rows, 240 posting IDs, and 240 background receipts. Routine network
reconciliation can clone it again. Its byte size was not measured, so no MiB
saving is claimed. A lightweight runtime bookmark is a useful next mod-owned
memory improvement, gated to native finance authority. Complete native ledgers,
transition source snapshots, verification, and rollback payloads must remain
intact. Resolve the bookmark fallback restore path before dropping its finance
fields; do not truncate native history or alter generic snapshot contracts.

## Implemented Open World change

`portolanBinaryPathOutsideHalo` now scans numeric bounds and rejects finite
binary ribbon paths strictly disjoint from every render-region box before
allocating coordinate/interpolation arrays. Edge contacts, crossing paths,
disjoint region unions, and malformed vertices retain the existing handling.
Circle rejection uses its enclosing box conservatively. Native data and picking
identity remain intact. No persistent cache or additional worker was added.

The real guard-seam regression initially observed 20,000 unnecessary remote
vertex arrays; it now observes zero. A matched-location sampled clip/containment
total was approximately 77 ms before versus 55 ms after. This short sample
supports less targeted work, not a general FPS or resident-memory claim.

Guard generation 38 replaces generation 37 and its old wrapper on reload.
The unique bundle marker is `portolan-binary-bbox-rejection-v8`.

## Implication for off-tile station naming

The current naming button loads no additional road data. Loading a full extra
road package into the renderer would compound an already large heap/backing
footprint and can increase GC stalls or allocation failure risk. Clearing
references afterward does not eliminate the peak.

Prefer a compact generated named-road index where native naming parity permits
it. Otherwise process one tile at a time in a short-lived worker, return only
name results, and terminate it before moving to the next tile. Measure actual
parse/index peaks and account for worker and backing storage as well as the
main heap; current headroom diagnostics alone cannot certify safe admission.
Native naming parity and roads near tile boundaries still require validation.

## Delivery and local evidence

- Shared platform/fixture tests: **1,322 passed**.
- Japan behavioral tests: **7 passed**.
- Built from `prototype/japan/mod`; installed only `local.japan-open-world`.
- Built/installed SHA-256:
  `602A7355AE165AE8A2F54C1588D5D743A7794FD1C7023F1EB4D3CE2F222FFA66`.
- Both bundles have identical timestamp `2026-10-07T23:22:48.3037253Z` and the
  unique marker. Reloaded runtime reports generation 3 and guard 38; the CPU
  profile samples `portolanBinaryPathOutsideHalo` in the executing bundle.
- Map-move diagnostics were reset, exercised, then disabled. Input observers,
  debugger sessions, and temporary input globals were cleaned up.
- PMTiles port 8799 returns HTTP 200 and
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

Raw captures and machine-local helpers remain Git-ignored under `.analysis/`:
`perf-baseline-a.json`, `perf-zoom-repeat.json`, `perf-zoom-cpu-*`,
`perf-zoom-within.json`, `perf-zoom-no-roads.json`, `perf-zoom-no-markers.json`,
`perf-after-matched-all.json`, `perf-after-matched-cpu-*`,
`perf-input-baseline.json`, `perf-input-after-matched-repeat.json`,
`perf-isolates-before.json`, `perf-roadworker-index-{before,after,repeat}.json`,
`perf-native-roadworker-replay.json`, `perf-memory-package-census.json`, and
`perf-instrumented-check.json`. Initial unmatched after-reload captures were
retained for transparency but excluded from the comparison table.

## Follow-up: retain visible markers during zoom

`native-zoom-refresh-v1` coalesces the native React zoom notification until
250 ms after a gesture ends. MapLibre and Deck keep moving their camera and
rendering the existing station dots and labels. The game then rebuilds its
marker model at the exact final zoom; its own 200 ms debounce can also apply
to small zoom changes. Other native detail changes using the same React zoom
value are deferred too. This removes repeated work during the gesture, while
the final full native rebuild can still cause a pause.

Construction, route editing, annotations, unknown interaction state, and
immediate camera jumps retain native behavior. Discovery checks the mounted
React map binding and callback shape, rather than importing a hashed native
bundle. Unsupported bindings keep native behavior. Pending work is canceled
on session/tile changes, map removal, and runtime disposal; reattachment
replaces the previous guard and wrapper.

The guard retains only current props/callbacks, one pending event, and one
timer. It adds no station-model cache or worker. A weak reference to the native
UI state queue avoids retaining its React component tree. A bounded Node GC
regression verifies collection of replaced props, callbacks, event payloads,
and the old UI tree while the guard remains installed. No live game GC or
heap snapshot was used for this follow-up.

The installed Japan runtime reports generation 4 and `native-zoom-refresh-v1`.
In live checks at zoom 14.4 and 16.2, each 42-notification burst produced one
refresh. Both station layers remained enabled and visible, and the prior native
model remained in use during the gesture. Final dots, labels, picking metadata,
and candidate positions/importance matched the native rendering signatures at
both zoom levels, including the grouped/individual station transition.

The camera, layer settings, paused clock, cached simulation mode, and counts of
1,462 stations, 277 routes, 9,324 tracks, and 1,287 trains were restored/preserved.
The renderer was background-throttled during these checks, so no new FPS or
frame-time improvement is claimed. Foreground timing remains a separate check.

- Platform/fixture tests: **1,333 passed**; Japan tests: **7 passed**.
- Built from `prototype/japan/mod`; installed `local.japan-open-world` only.
- Built/installed SHA-256:
  `0ED23DC7F9583FB4599E6EDD4F9FBC1ECDD9DB0C7A73F0FF5758E132A5C1C52D`.
- Matching bundle timestamp: `2026-10-08T00:44:03.6772595Z`.
- PMTiles port 8799: HTTP 200, `native-pmtiles-directory-v4`.
- Map-move diagnostics were reset before each gesture check, then disabled.

`__japanDiagnostics__.nativeZoomRefresh` exposes `snapshot()`, `reset()`, and a
temporary `setEnabled(boolean)` bypass for matched foreground comparisons.
The guard is enabled in the final running game. Raw follow-up captures remain
Git-ignored under `.analysis/native-zoom-*.json`.
