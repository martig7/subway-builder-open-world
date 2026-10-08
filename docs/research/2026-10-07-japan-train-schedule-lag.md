# Japan route train-count lag

Measured the existing Subway Builder 1.7.2 debug renderer on 7 October 2026.
The active consumer was `local.japan-open-world`, built from
`prototype/japan/mod`, with city `JP_PREF_28`, 277 routes, 1,462 stations,
9,324 tracks, and 1,287 trains. Simulation was paused and cached execution was
enabled. This investigates the route scheduler's train-count action, rather
than purchasing inventory or physically spawning a train.

The reproducible command is
`node .analysis/train-schedule-perf.mjs .analysis/train-schedule-baseline`.
It executes the native scheduler's actual `setRoutes(updatedRoutes, false)`
call with Cross-Osaka's high-demand count increased by one, observes long tasks,
and restores the original route array. Three additions and three restorations
are CPU-profiled. Each capture checks route/train references, money, and clock
restoration. The pass condition is both action time and associated long tasks
below 100 ms; the initial capture failed all three rounds.

| Capture | Synchronous action, ms | Associated longest tasks, ms |
| --- | --- | --- |
| Initial build, markers visible | 301, 204, 201 | 436, 331, 322 |
| Experimental equivalent-station bypass | 164, 144, 143 | 287, 258, 256 |
| Installed expense fix, first capture after reload | 719, 178, 188 | 848, 302, 314 |
| Installed expense fix, repeat | 205, 177, 197 | 330, 305, 329 |
| Installed expense fix, both station layers temporarily hidden | 184, 176, 177 | 230, 217, 223 |

The first post-reload outlier is retained in the results. The overall action
still fails the smoothness condition: this delivery removes a mod cost, but
does not resolve the underlying native whole-network rebuild. The background
renderer was not focused; these are synchronous action and long-task timings,
not foreground FPS measurements. The native route panel itself was not mounted
during these captures, so its additional render work is outside this measurement.

The confirmed mod bug was an eagerly evaluated fallback:
`finite(track.length, lineLengthMeters(track.coords))`. JavaScript evaluates
the geometry walk even when the stored length is valid. The fix selects the
stored numeric length first and computes geometry only for missing/invalid
lengths. Native cost semantics are preserved, including non-negative lengths.
It adds no cache, worker, retained topology, or ledger changes. Across the six
actions in each CPU capture, `calculateGlobalExpenseProfile` inclusive sample
time fell from 242 ms to 37 ms, and to 36 ms in the repeat (about 85% less).
Inclusive CPU totals overlap and must not be added together.

The regression exercises two service expense calculations with 1,600 valid
tracks: it failed with 3,200 unnecessary geometry reads before the fix and
passes with zero afterward. A second test proves geometry fallback still
produces the same expense for undefined, NaN, infinite, and invalid lengths.
The existing native-finance suite has 21 passing tests. The final shared
platform suite passed 1,335 tests, and the Japan consumer passed all 7 tests.

The remaining native costs are visible in the CPU profiles:

- `updateStationRoutes` scans every route for every station and repeatedly
  constructs route station-node arrays (`perf-native-index.js:199487`).
- `setStations` recomputes nearby stations, the spatial index, station groups,
  and topology achievement checks (`perf-native-index.js:209821`).
- `AllStationMarkers` and its terminus calculation depend on the full routes
  array reference. Publishing a changed schedule rebuilds markers even when
  topology and presentation are unchanged (`perf-native-game-main.js:83887`).
- Native TPH data must change with the schedule; reusing it indiscriminately
  would make shared-track capacity calculations incorrect.

A read-only follow-up audit confirmed that `setStations`' tail callbacks are
topology achievements, not train-worker updates. Nevertheless the experimental
bypass is not shipped: station equality alone does not prove that native
capacity backfill or visual/manual group reconciliation is redundant after
other edits or imports. Skipping it also leaves the station-route scan and
marker rebuild. Replacing the setter with `updateRouteProperty`, or mutating
routes in place, would omit native TPH updates, schedule callbacks, or UI
subscriptions. The necessary private helper functions are not exported.

The durable native improvement is a schedule-specific mutation path that
preserves topology references, updates schedule-dependent TPH, and keeps native
callbacks. Marker calculations should depend on presentation/topology rather
than schedule changes, and compute color ordering once per model. These
improvements do not require an accumulating cache. For immediate relief in the
current game, temporarily hiding **both** Station Dots and Station Labels
reduced observed pauses from roughly 0.33 seconds to 0.22 seconds; it does not
remove the native setter's remaining pause.

Japan's built and installed bundles have matching SHA-256
`6E699BA286FC6BEDB4DFA7DA043B5FAF7A4BA99141F7B4510CC684CC554F47A8`
and timestamp `2026-10-08T01:06:18.7485903Z`. The installed directory is
`%APPDATA%/metro-maker4/mods/local.japan-open-world`. Reloaded generation 5
reports `__japanDiagnostics__.nativeExpenseLengthVersion` equal to
`native-expense-stored-length-v1`. PMTiles port 8799 returned HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

All captures restored the route schedule, train inventory, money, and clock.
The original camera, cached mode, and layer flags were restored after reload;
both station layers remain visible. The prior native zoom guard remains active.
Temporary profiler/wrapper state was removed; captures and harnesses remain
under the Git-ignored `.analysis` directory.
