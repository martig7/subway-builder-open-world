# Autosave stalls and renderer memory

This change runs in the shared mod. It does not alter the game archive, native
save format, rail topology, finances, autosave frequency, or completed-commute
retention. The measured consumer is national Japan (`local.japan-open-world`),
built from `prototype/japan/mod`, in `JP_KANAGAWA_MAINLAND`.

## Recording through the manager

The Windows Open World Manager now has **Debug recorder → Record game
diagnostics** and **Open recordings**. Enable the checkbox once; the shared tile
server retains the setting across manager closure, mod reload, and server restart.
It records until switched off. The manager shows whether samples are arriving,
the game has stopped sending them, or recording failed. No Codex session, Node
collector, remote-debugging port, or special game launch is required.

The server writes JSONL under
`%LOCALAPPDATA%\metro-maker4\open-world-pmtiles\logs\renderer-debug`.
Eight rotating files of at most 8 MiB keep retention within 64 MiB; older
recordings are replaced. Copy the relevant files after an incident if they need
to be kept. `renderer-debug-recorder.json` in the adjacent `state` directory
stores the enabled flag. Disabling recording keeps existing files.

`renderer-debug-recorder-v1` sends one bounded scalar payload per second when
enabled. It includes the active manifest/city, camera position, browser heap
estimates, high-water sample, and short tails of save, map, and memory events.
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

Browser heap counters can be rounded or stale, and their reported headroom is
not a crash prediction. Process private bytes include more than JavaScript heap
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

The manager now offers **Launch game with native logs**. Save and close the game
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
