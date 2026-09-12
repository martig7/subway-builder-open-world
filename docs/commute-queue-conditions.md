# Shared commute queue conditions

Ultra-high-speed and cross-tile commute updates now enter the midnight queue
through the same `queueCommuteRefresh` handler in `start-open-world.js`. Both
use the existing public schedule/fare hooks and committed-service observer.

Previously, cached ticks also treated replacement route, station, track, train,
inventory and other input references as commute invalidations. That extra path
could widen the cross-tile queue policy while ultra-high-speed mode was enabled.
It is removed. Reference changes continue to update costs and train billing
anchors without queueing a demand calculation. Worker results are invalidated
by a qualifying service/fare notification or a changed save/tile/demand context,
so harmless reference replacements during a calculation do not queue a retry.

| Condition under the shared classifier | Queue both commute updates? |
| --- | --- |
| Committed route-stop changes; deletion of a route with stops | Yes |
| Changed service count, schedule, frequency, or timetable | Yes |
| Existing train-type, station-type, and station-group service notifications | Yes |
| Public schedule, ticket-fare, and fare-group notifications | Yes |
| Blank route creation/deletion; route color or name | No |
| Unchanged service-property value | No |
| Construction/blueprints without a service notification | No |
| Inventory and live fleet/reference replacements without a service notification | No |

These are the existing cross-tile rules, not a second classifier. Initial
enabling and save/tile/demand replacement still prepare the required assignments
immediately. Both modes keep the existing midnight coalescing and retry behavior.

## Verification

The platform suite passes 844/844 tests and Japan passes 7/7. Twelve game-entry
cases compare both queue states through the real shared observer and hooks.
Additional tests check reference-only changes, late worker publication, expense
settlement, newly created train billing, and replacement of the v8 tick/save
wrappers by v9.

The active consumer is `local.japan-open-world`, built from `prototype/japan/mod`
and installed into the matching directory under `%APPDATA%/metro-maker4/mods`.
Built and installed bundles have SHA-256
`103E2E970695E0A758E9D3B285A120540F088D1872F0F2345C0636E82FB68856`
and timestamp `2026-09-12T19:58:13.4753545Z`. Both contain the unique
`open-world-cached-simulation-v9` marker and shared queue handler. The game reload
reports the v9 marker at runtime generation 2. PMTiles health returned HTTP 200
with `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

Live JavaScript verification in that reloaded game passed. Replacing the route,
station, track and train arrays with equal copies queued no work. Three service
notifications and one fare notification queued exactly `route-service-change`
and `fare-change`, with no immediate demand calculation. Duplicate midnight
flushes shared one promise; the active calculation count increased from one to
two, the active and cross worker requests overlapped, and both dirty states
cleared after the batch completed.

The synthetic notifications left the network unchanged, so all 47 off-tile
native finance profiles were reused. This is a scheduling/correctness check,
not a changed-network benchmark. The renderer paused in the debugger during
the check; resuming it allowed the existing batch to finish without another
reload. Its elapsed timings include that pause and must not be used as a
performance measurement.

Verification cleanup restored the original paused, enabled ultra-fast state.
The clock remained at 220790637 seconds, with 678 stations, 78 routes, 4382
tracks, 610 trains and all 34027 active demand cohorts assigned. Temporary method
wrappers and inspection globals were removed.
