# Fast zoom and pan frame pauses

Measured 2026-09-08 after the allocation fix in commit `cf162ce`.

The Japan save still has repeatable 100–250 ms frame gaps while moving the
camera, especially with simulation running. No gap reached 500 ms in these
captures. Several causes can be assigned directly from sampled stacks and trace
events; most running-mode gaps combine multiple kinds of work.

## Setup and scope

- Active consumer: `local.japan-open-world`, `prototype/japan/mod`.
- Live Osaka view: `JP_PREF_27`, 316 stations, 53 routes, cached Ultra enabled
  throughout. Movement guard generation 22. No game or mod reload for this test.
- Three passes, each approximately 36 seconds including inter-phase settling.
  Each pass tests pan, zoom, and combined movement with pause on and off.
- Eight movements per phase: cardinal and diagonal directions, alternating
  zoom levels from 8.5 to 13. Animations last 300 ms, with 550 ms between starts.
  Panning reaches offsets of ±0.28° longitude and ±0.19° latitude from the saved
  camera. Panning-only uses zoom 11.5. Total: 144 movement commands.
- Movements use the live MapLibre `easeTo` API, exercising the game's actual
  camera/rendering pipeline. These are scripted movements, not mouse-input
  latency measurements.
- First trace: paused then running. Second trace: running then paused. Both
  include 1 ms CPU sampling and V8/render-task tracing. A third pass omits CPU
  profiling and tracing to check that the stalls survive without those tools.
- Frame gaps measure `performance.now()` intervals between animation-frame
  callbacks. They measure renderer responsiveness, not GPU presentation timing.
  Phase setup jumps and settling are excluded from phase statistics. No gap
  exceeded 500 ms even when including that setup/settling data.
- The game was visible and focused at each phase boundary, with no visibility
  transitions or reported renderer exceptions. Original camera and pause state
  were restored in a `finally` block and independently verified afterward.

## Third pass: no CPU profiler or trace

These are the best estimates here of ordinary frame gaps after the route through
the map has been visited. Lightweight frame, long-task, and tile observers remain
active. Each row covers approximately 4.7–5.8 seconds and eight movements.

| Simulation | Movement | Frames | p95 gap, ms | p99 gap, ms | Maximum gap, ms | Gaps >100 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Paused | Pan | 665 | 10.5 | 16.7 | 26.7 | 0 |
| Paused | Zoom | 264 | 59.3 | 97.0 | 128.6 | 2 |
| Paused | Pan + zoom | 354 | 49.0 | 101.8 | 160.3 | 4 |
| Running | Pan | 341 | 80.5 | 111.7 | 120.1 | 9 |
| Running | Zoom | 144 | 138.4 | 183.5 | 248.4 | 22 |
| Running | Pan + zoom | 203 | 115.7 | 153.5 | 238.2 | 17 |

## Profiled repetitions

| Simulation | Movement | Pass 1 p95 / max, ms | Pass 2 p95 / max, ms | >100 ms, pass 1 / 2 |
| --- | --- | ---: | ---: | ---: |
| Paused | Pan | 13.2 / 28.9 | 12.9 / 31.0 | 0 / 0 |
| Paused | Zoom | 65.3 / 266.8 | 67.0 / 137.1 | 6 / 4 |
| Paused | Pan + zoom | 58.2 / 86.5 | 49.3 / 160.1 | 0 / 2 |
| Running | Pan | 84.5 / 126.1 | 97.1 / 215.4 | 11 / 12 |
| Running | Zoom | 150.7 / 182.2 | 149.1 / 251.0 | 24 / 20 |
| Running | Pan + zoom | 156.0 / 173.2 | 137.3 / 214.0 | 22 / 19 |

The repeated difference between paused and running panning is large. Zooming
remains expensive even while paused. Cache warming, different simulation times,
and profiler overhead prevent treating differences between passes as a precise
profiler-overhead estimate.

## Assigned causes

CPU samples are aligned to renderer frame gaps using a trace timestamp containing
`performance.now()`. GC events are restricted to the traced renderer main thread
(PID 39360, TID 40944). CPU amounts below are approximate sampled time; GC amounts
are trace durations. They should not be added together because native calls can
contain GC work.

### Native map-label glyph generation: clear isolated cause

The largest gap, **266.8 ms**, occurred during paused zooming in pass 1.
Approximately **218 ms** of samples are under MapLibre `getGlyphs → _tinySDF →
draw`, including **212 ms** in native `measureText`. A worker-message callback
occupies approximately **216 ms** in the trace. There is **no overlapping GC**.

This assigns the dominant cause to synchronous label-glyph generation. It was
absent as a comparable spike on the repeated path, consistent with newly needed
glyph/font work warming up; the specific label/font and cold-cache mechanism were
not independently isolated. Prefecture polygon complexity does not explain this
particular stall. Prewarming or moving glyph generation off the critical path is
a candidate follow-up, not a validated fix yet.

### Geometry preparation at zoom transitions: clear substantial contributor

A **252.2 ms** paused zoom gap includes approximately **79 ms** under
`snapshotInterlinedValue`, **18 ms** of geometry clipping, and Deck path
normalization/rebuilding. Five minor collections contribute **27.5 ms** total.
Two animation callbacks occupy approximately **142 ms** and **95 ms**.

A separate **251.0 ms** running zoom gap in pass 2 includes approximately
**106 ms** of `clipPortolanBinaryPaths` and its clipping helpers. GC overlaps
approximately **46 ms** of the same gap. These are mixed geometry/rendering/GC
stalls; assigning the entire gap to any one function would overstate the evidence.

The preceding allocation fix reduced temporary allocations on comparison hits.
It did not remove the cost of taking new geometry snapshots, clipping paths,
rebuilding Deck attributes, or walking a large retained snapshot. A follow-up
should target repeated materialization around zoom/visibility changes and keep
expensive work out of a single animation callback.

Source: `open-world-platform/src/runtime/ui/geographic-context-overlay.js`,
`clipPortolanBinaryPaths`, `snapshotInterlinedValue`, `maskMovementDeckLayers`.

### Native finance history copying and dashboard work: repeatable running-mode cause

The **126.1 ms** running pan gap in pass 1 includes approximately **98 ms** in
finance copying/posting stacks. The **215.4 ms** running pan gap in pass 2 includes
approximately **72 ms** in finance copying/posting and **46 ms** in the native
`FinancialDashboard`, with approximately **13 ms** of overlapping GC.

Other repeated 150–200 ms gaps include `cloneHistory`,
`captureAuthoritativeGlobals`, `deepCopy`, and `#prepareNativeFinanceSteps`.
The adapter clones the native financial history when capturing authoritative
globals; preparation also copies history and per-route records. Even its
frame-budgeted generator still has indivisible cloning/enumeration work. These
operations remain active in cached Ultra because native finances still advance.

One **187.6 ms** running combined-movement gap samples
`backgroundFinanceForHour → structuredClone` and contains a **40.1 ms major GC**.
The trace explicitly reports `V8.ExternalMemoryPressure`, with 989 MB external
memory against a 985 MB soft limit at that collection. Thus memory pressure can
also magnify a finance-copying stall; this event is stronger evidence than merely
observing that the heap is large.

The most promising recurring-stall follow-up is reducing redundant historical
finance copies and dashboard recalculation while preserving native financial and
save authority. No financial behavior was changed in this measurement task.

Source: `open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js`,
`captureAuthoritativeGlobals`, `#prepareNativeFinanceSteps` / `cloneHistory`;
`open-world-platform/src/runtime/world-tile-runtime.js`,
`#captureAuthoritativeGlobals`.

### GC: measurable contributor, not the sole explanation

The longest individual main-thread major collection in the measured phases was
**64.0 ms**. The longest minor collection was **13.3 ms**; individual incremental
marking steps peaked at approximately **5 ms**, though many steps can occur in a
single frame gap. Most identified long gaps combine these with application work.
The largest observed gap contained no GC at all.

## Evidence and reproduction

From the repository root, with Subway Builder debugging on port 9222 and the
desired save already loaded:

```powershell
node docs/research/diagnostics/measure-frame-pauses.mjs .analysis/frame-pauses-1
node docs/research/diagnostics/measure-frame-pauses.mjs .analysis/frame-pauses-2 --reverse
node docs/research/diagnostics/measure-frame-pauses.mjs .analysis/frame-pauses-light --frames-only
node docs/research/diagnostics/analyze-frame-pauses.mjs .analysis/frame-pauses-1
node docs/research/diagnostics/analyze-frame-pauses.mjs .analysis/frame-pauses-2
```

The measurement intentionally moves the camera and advances the live simulation
during running phases. It restores the initial camera and pause flag afterward;
elapsed simulation time is not rolled back.

Raw evidence is Git-ignored in `.analysis/frame-pauses-{1,2,light}.json`, with
`-profile.json`, `-trace.json`, and `-summary.json` companions for the two traced
passes. Local grouped attribution is in `.analysis/frame-pauses-attribution.json`.
No full heap snapshots, forced collections, or runtime implementation changes
were needed.

Verified restored state: center [135.22923561644257, 34.744616664796396], zoom
10.112447351102523, bearing/pitch 0, paused false, cached Ultra true, 316 stations,
53 routes.
