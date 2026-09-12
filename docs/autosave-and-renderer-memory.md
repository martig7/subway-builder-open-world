# Autosave stalls and renderer memory

This change runs in the shared mod. It does not alter the game archive, native
save format, rail topology, finances, autosave frequency, or completed-commute
retention. The measured consumer is national Japan (`local.japan-open-world`),
built from `prototype/japan/mod`, in `JP_KANAGAWA_MAINLAND`.

## Save boundary

The current save reproduced a 62.8-second synchronous Electron context-bridge
handoff after 1.1 seconds of snapshot generation. The read-only probe passed the
snapshot as an unused argument to the inspected no-argument `electron.getVersion`;
the preload discards that argument, isolating bridge work from save compression
and disk writing. This is a boundary reproduction, not a full autosave timing.

`native-save-reference-sharing-v2` avoids replacing already shared route lists,
completed-commute records, and their arrays. It uses compact numeric segment keys
instead of nested copies of route/station ID strings. Values remain unchanged;
temporary sharing tables live only for that snapshot preparation. The cached
simulation wrapper generation is incremented so a hot attachment uses the new
implementation in both native and cached simulation modes.

Repeated small demand and finance values are also shared, with per-field limits
of 50,000 interned containers and 1,000,000 visited containers. Numeric hashes
are checked against exact keys/values; unfamiliar objects and custom serialization
retain native behavior. These tables are discarded after preparation.

On the same paused live snapshot, the isolated bridge measured 68.9 seconds
before and 37.7 seconds after targeted value sharing, plus 1.55 seconds of
preparation in that prototype (43% less combined blocking work). The hardened,
installed implementation then completed a normal native autosave with 0.68 seconds
of snapshot generation, 2.11 seconds of sharing, a further 33.21-second synchronous
gap, and 40.75 seconds to completion. After the final restart, another native
autosave blocked for 38.30 seconds and completed in 43.23 seconds, with no save
error. A substantial freeze remains.

This trades scratch allocation for fewer objects at the expensive bridge. An
offline real-save measurement allocated about 134 MB more temporary scratch;
after releasing the original snapshot and collecting garbage, the outgoing graph
retained about 35 MB less memory (193 MB to 158 MB). These figures do not establish
the peak inside Electron's synchronous transfer. Whole-graph JSON-string-key
interning was rejected because its additional allocation and CPU cost were worse.

Autosave callback entry, first synchronous return, completion/error, native
snapshot generation, and reference sharing have separate activity markers. The
callback's first return does not necessarily include the bridge stall: later
awaited work may block. Use the sampler's time gaps and an external capture to
measure the entire event.

## Rendering memory

`native-autosave-idle-v4` releases React's initial autosave callback when React
replaces it. The old property descriptor retained that callback even after the
active callback changed. Live inspection confirmed a chain from that stale
callback through the previous cached-simulation wrapper into an entire retired
World runtime. `native-saved-reload-v7` also releases the preceding guard on
direct replacement, carrying forward only its compact saved-file identity.
Weak-reference regressions verify collection of both obsolete callbacks and
their captured state.

`rail-render-bounded-static-snapshots-v34` caps the optional deep snapshot used
to validate static geometry when a hidden layer becomes visible again. Small
geometry retains this optimization. Large geometry keeps reuse during ordinary
visible frames and re-clips on reveal, instead of retaining an entire duplicate
road collection merely to validate it. Edits while hidden remain visible.

The regression benchmark's 30,000 road features, with eight coordinates each,
retained about 30.2 MiB before and 0.35 MiB after the change. Preparation took
168 ms before and 5 ms after on this machine. This is a measurement of that
cache, not the whole renderer or a guarantee that the renderer cannot exhaust
its heap.

`renderer-dormant-tile-budget-v1` limits each supported MapLibre source to 64
dormant tiles, falling to 16 when the reported heap pressure is elevated/high.
After ten seconds of continuously observed normal pressure, it restores the
normal limit. It preserves smaller existing limits and does not evict current
viewport tiles. Revisiting an evicted area can require tile decoding again.
The baseline bound works independently of heap-counter precision.

## Diagnostics during normal play

`renderer-memory-pressure-v1` automatically records scalar samples every second,
plus save/map activity boundaries. Its fixed rings hold 300 samples, 100 events,
and 60 activity markers. It records high-water usage, reported headroom, growth
spikes, inferred GC drops, and gaps between observations. No game objects are
retained, no heap traversal runs, and no garbage collection is forced.

```js
__enableOpenWorldRendererMemoryDebug({ reset: true })
__printOpenWorldRendererMemoryDiagnostic()
__japanDiagnostics__.tileCacheBudget()
```

The browser's `performance.memory` counters may be quantized and stale.
[Chromium's implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/timing/memory_info.cc)
caches its bucketed measurements for twenty minutes; precise mode avoids that
cache. Treat these browser counters as estimates, and use the external recorder
for timely measurements. Headroom is not a prediction of the precise point at
which V8, native buffers, GPU allocations, or the operating system will fail.
The final verification launch uses `--enable-precise-memory-info`; this changes
the launch only, without editing the game bundle. Subsequent ordinary launches
may again expose stale browser counters; the external CDP recorder remains
independent of that setting.

Every thirty seconds, and upon entering elevated/high pressure, a compact scalar
breadcrumb also goes through the game's existing `electron.logInfo` API when
available. These breadcrumbs survive renderer reloads in the native log.

For a capture that survives a renderer crash, start the game with its local CDP
endpoint available and run from the repository root:

```powershell
node --max-old-space-size=128 open-world-platform/scripts/monitor-renderer-memory.mjs --output .analysis/renderer-memory-new.jsonl --duration-seconds 900
```

The output must be a new file. The recorder selects the Subway Builder renderer,
records precise `Runtime.getHeapUsage` values and compact mod diagnostics, and
logs unresponsiveness/disconnects/reloads. It leaves only one renderer request
outstanding during a freeze. Backing-store and embedder values are separate
fields; they are not blindly added to the JavaScript heap estimate. Sampling
cannot observe allocations inside a blocked synchronous bridge call.

## Regression commands

```powershell
node --expose-gc open-world-platform/scripts/benchmark-static-render-cache-heap.mjs 30000 --assert-budget
cd open-world-platform
npm test
cd ../prototype/japan/mod
npm test
node scripts/build-mod.mjs
```

Build and installation remain separate. Verify the markers in the Japan bundle
and installed `mods/local.japan-open-world/index.js`, verify the shared PMTiles
health response, and reload the intended mod before measuring behavior.

## Delivery verification, September 12, 2026

The shared suite passes 879 tests; the active Japan consumer passes seven. The
built and installed bundles match, with all seven implementation markers present.
The shared service responds HTTP 200 with `native-pmtiles-directory-v4` and
`stored-driving-routes-v1`.

After restarting and reloading the final bundle, live generation 3 reports both
new retention guards. A weak reference to the retired runtime cleared after
replacement startup completed and diagnostic garbage collection ran. The settled
JavaScript heap fell from 1.33 GB to 1.20 GB across that reload. An earlier check
at five seconds was premature: startup itself took about nine seconds. These
collection checks are explicit verification only, not a forced-GC gameplay loop.

With cached simulation restored, the final eight-position camera sweep peaked
at 1.74 GB of CDP JavaScript heap and 657 MB of backing storage, measured
separately. Its post-collection JavaScript floor was 1.58 GB. The browser's
broader counter peaked at 2.42 GB (56.3% of its reported limit), leaving 1.88 GB
of reported headroom. No renderer crash was reproduced in these sweeps; this
does not establish long-session crash prevention. The recorder captured both
save stalls and camera growth, and native-log breadcrumbs were verified in
`D:\SubwayBuilder\logs\metro-maker-current.log`.

A 30-minute recorder started for the final gameplay session writes to
`.analysis/stability-live-final.jsonl`, using a 128 MB Node heap limit. Its process
used roughly 50 MB during verification. The game remains paused with cached
simulation enabled and ready, and its pre-crash camera restored.

The final built/installed bundle SHA-256 is
`924B1716739B097486BCD3B29F499CD7BA1F2E375F5D83864DDE31C6CA90F250`,
with matching UTC timestamps `2026-09-12T22:11:26.1850974Z`.

Comparing the native files immediately before and after installation showed
identical tracks, trains, routes, stations, demand, clock, ownership, and monetary
history values. The only `data` difference was the existing
`financialHistory.openWorldAuthoritativeWorldId` binding metadata initialized
during reload. The paused game retained its 737 stations, 4,746 tracks, 76 routes,
654 materialized trains and 4,326 owned-train count. Diagnostic backups and raw
captures are Git-ignored under `.analysis/stability-*`.

During verification, an incorrectly scoped GC test fixture retained its own
sample array. Its failing subprocess grew to approximately 37 GB and may have
contributed to the user's computer crash. The test processes were terminated.
The corrected fixture uses a separately scoped replacement callback and a small
sample; assertions report scalar collection status. Both GC subprocesses now
have a 128 MB V8 heap limit and a 15-second timeout. Final suite execution uses
at most two test workers, each with a 512 MB heap limit. The corrected retention
tests complete in under a second. This incident was in the test tooling, not
evidence of a game renderer crash.
