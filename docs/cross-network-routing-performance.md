# Cross-network routing: Japan regional benchmark

Measured on 2026-09-07 using **Japan Regional 316 - Tokyo to Kobe**, the native
regional save described in `recovery/japan-regional-network-report.md`.
Consumer: `prototype/japan/mod`, manifest `local.japan-open-world`.
Implementation marker: `cross-network-graph-cache-v1`.

## What changed

- Cross-mode workers and their synchronous fallback retain a bounded routing
  cache across evaluations. Native-demand evaluation also shares a cache between
  outward and return trips; its worker retains it across requests.
- Geometry, directed connectivity and service-dependent searches have separate
  dependencies. Cloned worker inputs compare by exact serialized content, without
  trusting the old 32-bit profile signature. World changes clear the cache.
- Strongly connected components and a condensed reachability index reject
  structurally impossible station pairs before routing. Time-dependent service
  availability is still evaluated by the routing search.
- Exact access times, access modes, departure time and routing rules identify
  reusable origin searches. A retained priority queue can continue toward another
  destination. Exact journey results also survive fare-only reevaluation.
- Unambiguous ride corridors retain their original edges but skip intermediate
  priority-queue operations. Branches, transfers, destination stations and cycles
  remain explicit. Departure waits, dwell, egress and onboard state are preserved.
- Linked predecessor labels replace repeatedly copied full paths. The final
  station and route sequence is materialized only for the selected journey.
- Weakly connected regions define conservative invalidation dependencies. A
  service edit in a disconnected region preserves other regions' cached results;
  adding a connection invalidates the merged region, including journeys that
  could benefit from a new alternative. Adjacency order is included because
  equal-cost route choices can affect fare attribution.
- Existing endpoint and gateway topology caches now provide a feasible upper
  bound for an exact search. A replay that remains usable is no longer assumed
  to remain optimal. Tile-adjacency gateway chains are cached separately.
- Saved evaluation context keys include the routing implementation version, so
  the previous algorithm's derived results are recomputed after installation.

Default retained limits are 30,000 search labels, 8,192 exact paths, 65,536
catchments, 256 region signatures, and bounded gateway/endpoint/reachability
caches. These are entry/label limits, not a measured byte ceiling. Eviction is
safe and only causes recomputation; cached data is never a Native Save authority.

## Controlled measurements

The original native file remained unchanged (SHA256
`846b18707c4aa3f82a3f5b060f8637cef733b57dd12c187b41cdab18fb5415df`).
The game was paused in Osaka (`JP_PREF_27`) at 59,536 elapsed seconds with
316 stations, 53 routes, 2,294 tracks and 233 trains.

The primary benchmark interleaves seven old-worker, installed-worker cold, and
installed-worker warm evaluations in the same live renderer. It waits for startup
recalculation to finish, warms the baseline worker before timing, and includes
structured-clone transport, authoritative native fare callbacks and settlement
calculation. Each cold pass uses a fresh cache namespace; its following warm pass
uses identical inputs. Raw samples are in `cross-network-routing-japan-benchmark.json`.

| Live worker evaluation | Median | Speedup versus baseline |
| --- | ---: | ---: |
| Previous implementation | 1,104.5 ms | 1.00x |
| New implementation, empty caches | 967.5 ms | 1.14x |
| New implementation, warm caches | 549.9 ms | 2.01x |

All 21 output hashes match, covering every population's mode choice, flow totals,
journey timing, route attribution and native fares. There are 33,553 evaluated
demand groups and 2,981 transit-viable groups. Warm evaluations perform zero
searches or edge relaxations, with 2,991 exact-path hits. Cold evaluations share
726 origin searches and contract 11,622 corridor edges.

An additional five-repeat Node replay uses the captured live network and demand
with the scalar fare input (native fare callbacks cannot be serialized). Its
medians were 1405.4 ms old, 1218.6 ms cold and 423.5 ms warm: 1.15x and 3.32x.
Every output matches both the old algorithm and the new algorithm with graph
optimizations disabled. These Node timings are not live worker timings.

The save has one connected passenger network, so connectivity rejection and
preserving disconnected regions do not contribute to this benchmark's speedup.
Those behaviors are covered by targeted tests. A service change within this
connected network conservatively invalidates its region; this is not arbitrary
fine-grained invalidation inside a connected network.

These measurements are cross-network computation times, not frame rates or total
startup times. Full startup also performs native-demand compilation for 47 tiles,
native commute refresh and other work. One post-install startup recalculation
measured 12.8 seconds; this experiment does not establish a total startup speedup.

## Validation and reproduction

- Platform suite: 587 tests pass. Japan consumer suite: 4 tests pass.
- Regression tests cover missed departures, equal-cost route attribution,
  connectivity direction, corridor dwell/egress, service and coordinate changes,
  World isolation, disconnected edits, new connections, eviction, and 25 seeded
  branching networks compared with uncached routing.
- The missed-departure regression fails against the original implementation and
  passes against the new implementation.
- The Japan consumer was rebuilt and installed. Built and installed bundles have
  matching SHA256 and timestamps and contain the version marker. A reloaded live
  worker reports that marker and per-evaluation reset routing counters.
- The shared PMTiles endpoint returns HTTP 200 with
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
- A native runtime recalculation completed successfully with all 47 native-demand
  profiles cached. A six-second live simulation check advanced 304 game seconds
  without new error/unhandled-rejection events or route disruptions. Station,
  route and track counts were unchanged. The game was left paused at 59,840
  elapsed seconds (16:37:20); the original native file was not overwritten.

Baseline source commit: `30f800a7503a666e798cd81e0ea4c133c6553eb0`.
Final built and installed bundle SHA256:
`fdc027c92e615fbb32d5e792d03ce481ebd1e106f9d34f229c19c6676fef9a85`.
Both timestamps: `2026-09-07T19:11:25.2935642Z`. Live generation: 3.

Captured live inputs and the old standalone module remain local under ignored
`.analysis/graph-regional-input.json` and `.analysis/graph-baseline.mjs`. Replay:

```powershell
node open-world-platform/scripts/benchmark-cross-routing.mjs `
  .analysis/graph-regional-input.json .analysis/graph-baseline.mjs `
  .analysis/graph-replay-report.json
```

The repository does not distribute the user's native save or demand capture.
The local interleaved live harness is `.analysis/graph-live-interleaved.js`; it
uses the production installed evaluator and a temporary old worker compiled from
the baseline module. The temporary baseline worker is disposed after comparison.

During setup, an in-place native save load crashed the old renderer before any
runtime code changes. Loading the original through native pending-save staging
and a fresh renderer succeeded. This is not counted as a routing regression or
as evidence of a crash fix.
