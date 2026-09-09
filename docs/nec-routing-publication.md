# NEC routing publication

## v0.6.0 verification

The 36-tile build was installed and reloaded in Subway Builder. All 153,140
native and 57,699 cross-tile archive records have OSRM road geometry. Native
archives occupy 245,441,510 bytes and cross archives 262,951,963 bytes on disk.
The audited timing publication preserved 17,807,299 native workers and
6,640,574 cross-tile workers, along with all cohort identities and endpoints.

Through the running game's actual path fetch adapter, a 936.59 km cross-tile
route returned 14,077 coordinates in 40.4 ms; a Brigantine cross route took
6.3 ms. Native route samples took 3.7–12.9 ms. Five cached records used 149,278
accounted bytes, with no errors or fallback records. These are observed request
latencies, not filesystem-cold benchmarks.

An actual UI tile switch into Brigantine (`NEC_CP00_RM02`) completed in 10.512 s
and restored 9,733 buildings and 15 native demand cohorts. Return to NYC took
19.339 s and restored 2,013,662 buildings and 48,316 cohorts. Both retained the
316-station, 53-route, 244-train benchmark network, pause state and simulation
clock. The old NYC cohort count was 48,317; the updated footprint's demand
package correctly contains 48,316. This was a correctness check with concurrent
release work, not a controlled comparison with earlier timing benchmarks.

The shared service served all 36 NEC tiles and advertised the stored-route
header. Built and installed bundle SHA256 matched:
`106cfdedaa02927e5c3e66715192f1996ae5d544d1a1e0a6effa0813420da5bc`.
All 728 platform, 18 NEC and 3 route-archive tests passed. The NEC suite now
rejects a footprint rebuild that republishes the old generated-road timing
model instead of individual OSRM routes. Installation exposed
and fixed a UTF-8 BOM compatibility issue in shared World registrations; the
regression test verifies that a BOM registration reuses a healthy server.

Exact measurements: [nec-v060-routing-results.json](nec-v060-routing-results.json).

## Publication process

NEC v0.6.0 uses the same shared routing and stored-path implementation as Japan.
Its World enables `stored-driving-routes-v1` and the `shared-native-v4` service.
The release consumer is `prototype/nec-corridor/mod`, with installed manifest
`northeast-corridor-open-world`.

After changing the NEC footprint or demand, publish routing in this order:

1. Generate the new demand while preserving its cohort identities, endpoints and
   worker totals.
2. Run `python -m open_world_map_creator.routing` on the configured Runner with
   `--routing-provider osrm`, the NEC dataset identity and endpoint, and the
   validated passenger-ferry catalog and physical-land mask. Use
   `--report-namespace nec`, `--consumer-manifest-id local.nec-corridor-open-world`
   and `--max-routed-direct-metres 3000000`. The legacy `nec_world_builder`
   `enrich-driving` command alone uses generated roads and does not complete this
   publication step.
3. Verify `nec-road-routing.json` reports provider `osrm` and cross publication
   `individual-osrm-cross-v1`. Verify that only route time/distance and routing
   metadata changed; cohort identities, endpoints, masses and schedules must not
   change in this step.
4. Run `map-creator/scripts/build_route_geometry.ps1` against that final demand
   using the same NEC OSRM dataset. Write to `generated/routes`. This produces
   native archives for all 36 tiles and one cross archive. Keep the SQLite build
   cache on the Runner; it is not installed.
5. Build `prototype/nec-corridor/mod/scripts/build-release-mod.mjs` from split
   map/demand artifacts. The shared builder verifies every route archive hash
   and its exact input demand hash before packaging. A subsequent demand change
   requires republishing archives; stale archives must not be reused by editing
   their manifests.
6. Install the matching consumer, native demand, route archives and new tile.
   Verify service health includes `X-OpenWorld-Route-Archive:
   stored-driving-routes-v1`, then reload the game and verify native and cross
   paths through its `map://paths/<city>/<pop>` fetch adapter.

The pinned NEC dataset for this release is
`geofabrik-nec-fa3341c01012db3c-car-v6`. Runner paths and endpoint selection are
machine configuration, not World facts. Heavy generation belongs on the
configured Runner.

Stored geometry describes the driving line, as in Japan. Explicit OSRM
`NoRoute`/`NoSegment` archive records use a geometric display fallback; they do
not claim to display a road or ferry path. Travel-time publication separately
uses the validated ferry/water policy. The renderer loads only requested paths
and uses the shared 8 MiB/256-entry bounded cache; it does not load the archive
collection into its JavaScript heap.
