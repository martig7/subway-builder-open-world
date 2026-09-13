# Autosave stalls and renderer memory

This change runs in the shared mod. It does not alter the game archive, native
save format, rail topology, finances, autosave frequency, or completed-commute
retention. The measured consumer is national Japan (`local.japan-open-world`),
built from `prototype/japan/mod`; captures below name their active city.

## Recording through the manager

The Windows Open World Manager now has **Debug recorder → Record game
diagnostics** and **Open recordings**. Enable the checkbox once; the shared tile
server retains the setting across manager closure, mod reload, and server restart.
It records until switched off. The manager shows whether samples are arriving,
the game has stopped sending them, or recording failed. No Codex session or Node
collector is required. Process/console recording works with an ordinary launch;
precise V8 measurements require **Launch game with diagnostics**, described below.

The server writes JSONL under
`%LOCALAPPDATA%\metro-maker4\open-world-pmtiles\logs\renderer-debug`.
Eight rotating files of at most 8 MiB keep retention within 64 MiB; older
recordings are replaced. Copy the relevant files after an incident if they need
to be kept. `renderer-debug-recorder.json` in the adjacent `state` directory
stores the enabled flag. Disabling recording keeps existing files.

`renderer-debug-recorder-v1` sends one bounded scalar payload per second when
enabled. It includes the active manifest/city, camera position, separate browser
estimates and verified V8 readings, high-water sample, and short tails of save,
map, and memory events.
Only one request is in flight; requests time out after three seconds, and an
unavailable/disabled server is polled every five seconds. There is no retained
upload backlog, game-state traversal, full heap dump, or forced GC. The server
rejects payloads over 32 KiB and nested game objects.

The server independently samples up to 32 `game` processes each second, recording
their PID, working set, private bytes, and observed exit where available. These
records continue during renderer stalls. After five seconds without a renderer
sample it writes a silence event, then a recovery/attachment event when samples
resume. Silence alone is not evidence of a crash: a closed game, reload, or
throttling can also cause it. Activities that occur entirely between the final
upload and a crash may be lost.

Browser heap counters can be rounded or stale and include external memory; they
no longer supply headroom. Process private bytes include more than JavaScript heap
and must not be compared directly with the browser's heap limit. Use both
streams with the native game log to distinguish a heap estimate, total process
growth, an autosave stall, and a process exit.

On September 13, the installed national Japan consumer (`prototype/japan/mod`,
manifest `local.japan-open-world`) reloaded in `JP_PREF_11` and uploaded real
samples through the installed server. The manager showed recording enabled and
an increasing count; the preference file contained `enabled: true`. The server
remained healthy with 83 archives and used about 69 MiB of private memory in the
initial live check. Its build and installed executables matched, and the Japan
bundle SHA-256 matched on both sides:
`B00B51BFFE2C39196873C5E35954DD3E59FC06B4E04CE53B8D33E041B326D1F4`.
Validation passed 885 shared tests, seven Japan tests, and 29 native tests,
including real HTTP control, restart persistence, tile serving while recording,
file rotation, disk failure containment, payload bounds, process disappearance
when exit-code lookup fails, and hot replacement.

The first live capture recorded an autosave beginning at 19:51:24 UTC: generation
took 214 ms, sharing 2.876 seconds, then the renderer showed an 81.280-second
sampling gap. The save completed in 90.825 seconds. Independent process samples
continued throughout, peaking at 7.882 GB of private bytes for renderer PID 8756
during the save. The native game log subsequently reported a renderer crash at
19:53:16 UTC, reason `crashed`, exit code `-36861`. The server had a process sample
0.3 seconds before that event (6.337 GB private bytes), observed the PID disappear,
and accepted a new renderer/capture afterward. The last browser heap estimate,
about nine seconds before the crash, was 2.79 GB against a reported 3.76 GB limit;
its stale/rounded readings do not establish OOM or rule it out. Recording survived
the real incident; the underlying autosave stall and crash remain unresolved.
The initial capture and summary are preserved locally under the Git-ignored
`.analysis/manager-recorder-native` directory.

### Native output after a renderer crash

The manager now offers **Launch game with diagnostics**. Save and close the game
first, then launch it from that button. It enables Chromium warning/error/fatal
file logging and Electron's in-process stack dumping, and starts an independent
capture helper for stdout/stderr. A renderer reload does not erase these files.
The tile server also archives the existing game console log while its recorder
is enabled, including the configured custom save directory's log.

**Open recordings** contains the memory/console JSONL timeline and a `native`
folder with timestamped native output plus current/previous raw Chromium logs.
The helper remains active until the game closes, including when the manager or
tile server restarts. Turning off the checkbox stops memory/console archiving;
the separately shown native session ends on game exit. Its additional rolling
history is about 32 MiB, with a bounded 64-chunk queue and explicit loss markers
when output exceeds disk throughput. It does not take a heap dump.

The September 13 exit code `-36861` corresponds to Crashpad's
`kTerminationCodeNotConnectedToHandler` (`0xFFFF7003`). It means Crashpad could not
reach its handler while trying to crash/dump; it does not identify the original
fatal condition. Native logging can preserve a fatal message or stack that was
previously lost, but cannot recover a trace the game never emits. Electron also
documents that `ELECTRON_ENABLE_STACK_DUMPING` has no effect if its crash reporter
has been started. A real subsequent crash is still needed to determine whether
this game's renderer produces a usable trace.

References: [Electron logging switches](https://www.electronjs.org/docs/latest/api/command-line-switches),
[Electron stack dumping environment variable](https://www.electronjs.org/docs/latest/api/environment-variables),
[Crashpad termination codes](https://chromium.googlesource.com/crashpad/crashpad/+/refs/heads/main/util/win/termination_codes.h).

Native tests exercise stack-shaped stdout/stderr and Chromium text surviving a
child's exit, Unicode split across file reads, large newline-free output, bounded
backlog and file retention, unavailable disk/state files, stale helper status,
and authenticated launch refusal while a game is already running. These tests
verify the recording path, not reproduction or resolution of the game's crash.

Delivery check on September 13: all 33 native tests passed. The installed manager
and trimmed server match the candidate hashes, and the service advertises
`native-crash-logs-v1` while serving all 83 installed archives. The unchanged
national Japan bundle sent fresh `JP_PREF_11` samples after the service restart.
The first live check found 13 archived game-console chunks alongside renderer
samples; server private memory was 66.6 MiB. The installed manager layout was
rendered and inspected. Native launch verification requires the user's saved
game to be closed and relaunched from the new button; no running game was
terminated to perform these checks. Candidate binaries, rollback copies and the
UI capture are local in `.analysis/native-crash-logs`.

### Precise measurement delivery, September 13, 2026

The replacement recorder passes 890 shared tests, seven Japan behavioral tests,
and 36 native tests. The captured 116 MB stale reading is a regression fixture:
it now yields unavailable headroom instead of normal pressure. Tests also cover
separate backing storage, sample expiry including debugger delay, delayed save
markers, sampling gaps, endpoint identity, bounded replies, and stalled requests.

The rebuilt `prototype/japan/mod` and installed `local.japan-open-world/index.js`
match SHA-256 `35F6A555673297AB5BDB8133BFA06FC075C02935E61948F3A44A1D53341FA818`
and UTC timestamp `2026-09-13T22:23:46.4939784Z`, with
`renderer-memory-pressure-v2` and `renderer-debug-recorder-runtime-v2` present.
The installed manager and tile server match their published candidates. The
service serves all 83 registered archives with `native-crash-logs-v2`; installed
map packages were not regenerated or replaced. Local rollback copies and
verification artifacts are in `.analysis/precise-memory`.

After the user relaunched through the manager, the helper reported the new
diagnostic launch and the sampler obtained a precise 4,294,705,152-byte heap limit.
At the menu, an independent `Runtime.getHeapUsage` check read 57,901,908 bytes of
V8 heap against the service's 57,861,332 bytes 180 ms earlier. Both reported about
23.7 MB of backing storage separately. Native queries took approximately 1 ms;
server and helper private memory were 70.2 and 55.2 MiB in this initial check.
These menu values verify measurement transport, not a gameplay memory budget.

After loading `JP_TOKYO_MAINLAND`, both runtime generation markers were verified
through the game, and reset diagnostics started at sample 1. The mod received
1,265,188,276 bytes of V8 usage with 597,561,515 bytes of separate backing storage,
3,029,516,876 bytes of reported headroom and a 270 ms conservative sample age.
An independent query moments later read 1,267,201,048 bytes of V8 usage.
Loading produced a 21.142-second gap in successful V8 samples while the longest
process-sampling gap was 1.343 seconds. A delayed mod sample at age 4.455 seconds
correctly reported unavailable pressure/headroom. The early observed V8 peak
was 1.57 GiB; these loading samples and gaps do not establish the save reserve.
Three subsequent autosave windows were captured by this first build: durations
88.375, 96.395 and 101.368 seconds, with main-heap sampling gaps of 85.752, 93.275
and 98.042 seconds. Their observed main V8 peaks were approximately 1.61 GB.
Those peaks are lower bounds; most of each synchronous save was unsampled.

The live session also exposed two `CALL_AND_RETRY_LAST` OOMs at 18:33:19.991 and
18:36:28.222 EDT. Main-isolate usage was only 1.258 and 1.296 GB in the last samples,
312 ms and 1,012 ms before the respective failures. Process private memory was
5.878 and 5.945 GB. A later scoped probe found 31 related workers: together with
the main page, 2.385 GB of live heap but 4.226 GB of allocated heap pages. The probe
was after the crashes and does not prove their precise allocation failure.
[V8 supports shared pointer-compression cages](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/docs/heap/pointer-compression.md);
the observed worker allocations are a reason to measure the combined footprint
before choosing a cache reserve. Main-isolate headroom alone cannot establish it.
Frozen evidence and a reconciliation are in `.analysis/precise-memory/crash-183320`.

The final update adds these worker measurements and isolate replacement handling.
It passes 891 shared tests, seven Japan tests and 36 native tests, including
duplicate-isolate counting, separate worker buffers, expiring worker samples,
allocated save peaks, and replacement under the same target ID. Restoring the old
target-only identity rule makes the replacement test fail with the stale peak.
The final Japan build and installed bundle match SHA-256
`629DC7D744228CF940B268FE45E43E7DD15B13819A55FAD47EEE8CD37BE25018`, timestamp
`2026-09-13T22:56:34.4081489Z`, and the two generation-3 markers. Installed server
and manager binaries match their candidates; all 83 archives remain healthy.
Live server status reported all 31 worker isolates with a 9.2 ms sweep, 3.38 GB of
combined allocated heap pages, and 79 MiB server private memory. The independent
native helper used 127.9 MiB at that check. Worker arrays and the 600-sample save
window remain bounded; these are short observations, not a long-duration leak test.

After the user's final reload, the game reported `renderer-memory-pressure-v3`
and `renderer-debug-recorder-runtime-v3`; reset sampling started at 1. That sample
contained 1.567 GB of main V8 usage, 1.094 GB of worker usage, and 3.426 GB of combined
allocated heap pages, with current worker coverage and a 19.6 ms worker sweep.
The server's current isolate ID matched the mod's. The live recorder also proved
that replacement under the same target ID resets the peak: after the 19:03:37.963
OOM, a different isolate first reported a 99 MB peak rather than its predecessor's
retained value. That incident's last complete measurement was 8.117 seconds before
the fatal event, with 3.476 GB of combined allocated heaps and 2.645 GB of live V8
heap. Process private bytes were 5.006 GB in a sample 274 ms before the fatal event.
The unobserved interval prevents claiming a precise heap value at the crash.
Evidence is retained in `.analysis/precise-memory/crash-190337`.

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

`renderer-memory-pressure-v3` automatically records scalar samples every second,
plus save/map activity boundaries. Its fixed rings hold 300 samples, 100 events,
and 60 activity markers. It records high-water usage, reported headroom, growth
spikes, inferred GC drops, and gaps between observations. No game objects are
retained, no heap traversal runs, and no garbage collection is forced.

```js
__enableOpenWorldRendererMemoryDebug({ reset: true })
__printOpenWorldRendererMemoryDiagnostic()
__japanDiagnostics__.tileCacheBudget()
```

The browser's `performance.memory` counters are not usable V8 headroom.
[Chromium's implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/timing/memory_info.cc)
caches its bucketed measurements for twenty minutes; precise mode avoids that
cache, but both modes add external memory to V8's used-heap counter. The old
recorder reported 116 MB and normal pressure seconds before two September 13
promotion-failure OOMs. The corrected reader retains that browser value as `browserUsedBytes`
with `measurementMode: estimated`, and leaves headroom and pressure unavailable.

For verified measurements, enable **Record game diagnostics**, save and fully
close the game, then use **Launch game with diagnostics** in the updated Windows
manager. The tile server's `renderer-v8-heap-v1` sampler reads
[`Runtime.getHeapUsage`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage)
once per second. `usedSize` supplies the V8 heap; `backingStorageSize` and
`embedderHeapUsedSize` remain separate. A one-time precise heap-limit query supplies
the budget denominator; a rounded/unverified limit is rejected. Headroom means
reported heap limit minus V8 used heap, not free physical RAM or guaranteed GC
promotion space. Main-isolate headroom and pressure do not describe renderer-wide
free space. Complete native/GPU allocations, fragmentation, and unsampled peaks
are not covered by this number.

`worker-v8-heap-v1` samples the current page's related worker targets with a
two-second minimum interval through unpaused, flattened debugger sessions. Up to 64 sessions and one
pending command are allowed; a three-second deadline covers the complete tick.
`Runtime.getIsolateId` prevents duplicate counting and resets history when a crash
reuses the same browser target for a new isolate. Worker live heap, allocated heap
pages, and backing storage remain separate. Fresh, complete worker sweeps supply
`allIsolatesUsedBytes` and `allIsolatesAllocatedBytes` in the mod's scalar upload.
The manager labels these as all *measured* heaps; missing/stale coverage is unknown.
These sums are observations of individual isolates at nearby times, not an atomic
snapshot or an exact map of free addresses in the V8 cage. Shared heap pages and
code outside the main cage can affect interpretation. No cache thresholds or
pre-autosave cleanup policy are changed by these added measurements.

The manager and mod reject samples older than three seconds, including query
response time in that age. The mod also rejects readings from before its current
page started. A blocked query becomes unavailable, with the sample timestamp,
query duration and gaps retained. Process private bytes continue to be sampled
independently during a blocked renderer. The server issues only one bounded
debugger request at a time, caps responses at 128 KiB, and waits before retrying.
The mod receives scalar readings through its existing recorder requests; neither
side retains game objects or forces garbage collection.

The manager shows main V8 usage, observed peak, workers, combined allocations,
and separate buffers. For each autosave attempt, `autosave-memory` reports a baseline within three seconds before the
start, the observed peak, the first sample within three seconds after completion,
minimum observed headroom, and the longest unsampled interval. Missing values stay
unknown. Completion describes the wrapped autosave callback returning/resolving;
the game can skip a write, so it is not proof that a new save file was persisted.
Use the native game log to distinguish a skipped attempt. The server keeps at most 600 scalar readings and matches delayed mod
activity uploads by their original timestamps. Query response timestamps locate
the samples; request duration records their timing uncertainty. Peaks are observed
lower bounds, especially when a save blocks the debugger. This capture establishes
the evidence needed to size a cache budget and pre-save reserve; it does not yet
change eviction thresholds or add pre-autosave cleanup.

Every thirty seconds, and upon entering elevated/high pressure, a compact scalar
breadcrumb also goes through the game's existing `electron.logInfo` API when
available. These breadcrumbs survive renderer reloads in the native log.

The manager recorder survives renderer crashes without a separate Node process.
For a standalone investigation, the older CLI collector remains available when
the game exposes the local CDP endpoint expected by that script:

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

Build and installation remain separate. Verify `renderer-memory-pressure-v3` and
`renderer-debug-recorder-runtime-v3` in the Japan bundle
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
broader counter peaked at 2.42 GB. Its previously reported 1.88 GB headroom mixed
external storage with V8 usage and is superseded by the separate measurements
above. No renderer crash was reproduced in these sweeps; this
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
