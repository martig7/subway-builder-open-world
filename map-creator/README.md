# Open World Map Creator

This top-level package owns geography compilation, demand normalization, road
enrichment, reproducible storage, and Artifact Set publication for every World.
World authors provide a validated directory under `worlds/`; processing code is
not copied into that directory.

The default data root is `map-creator/data`, with content-addressed sources,
resumable work, immutable artifacts, and logs in separate subdirectories. Set
`OW_MAP_DATA_ROOT` to place heavy data elsewhere without changing artifact
identity.

Install the package with `python -m pip install -e map-creator` from the repository
root before invoking its commands. The required `jsonschema` dependency validates
World Definitions against the platform's canonical
`open-world-platform/contracts/world-definition.schema.json`; release wheels
include that same schema. Filesystem containment and catalog references are
checked separately by the loader.

## Computation geometry versus display geometry

World `map.computationBoundary` is a key under the central source store
(`map-creator/data/sources`, or `$OW_MAP_DATA_ROOT/sources`). Demand compilation,
verification and World-aware placement repair resolve it independently of
`tileViews.boundaryOverlay`, which is **display only**. A declared computation
source that is missing is an error, never permission to use a simplified overlay.
Changing camera zoom cannot change demand ownership or route endpoints.

Japan's unsimplified e-Stat prefecture file is preserved byte-for-byte at
`sources/japan/geography/prefectures-full.geojson` (6,387,880 vertices; SHA-256
`0982a0f483c1e5bd9525cea4fe4166e6fad291ef3c468284a2599bf639da788f`). This is
administrative/statistical geometry, **not** a physical land/water mask.
Prepare independent display levels with:

```powershell
python -m open_world_map_creator.geography `
  --computation-source <unsimplified-prefectures.geojson> `
  --computation-output <central-source-store>/japan/geography/prefectures-full.geojson `
  --display-source <detailed-display-coverage.geojson> `
  --display-output <world>/geography/display-boundaries.json
```

The shared-edge coverage is noded once before simplification. Levels start at
zooms 0/6/8/10/12 with tolerances 2000/500/100/25/0 metres respectively. Other
Worlds can supply their metric projection with `--display-crs`. The runtime
switches precomputed geometry only when the level or source changes, and updates
active/hover state without resending polygons. Legacy Worlds still work without
LOD data. The original detailed display source remains separate and untouched.

For physical routing, install the `geometry` extra and prepare actual land:

```powershell
python -m open_world_map_creator.routing.prepare_water_land `
  --coast-zip <land-polygons-split-4326.zip> `
  --pbf <same-source-used-by-osrm.osm.pbf> `
  --output <central-source-store>/japan/geography/physical-land.geojson `
  --bounds 120 20 155 47
```

This dissolves unsimplified OSM coastline polygons and subtracts inland water
assembled from OSM areas, retaining islands and holes. Inputs and output are
hashed in a companion report. OSM-derived geometry is © OpenStreetMap contributors,
ODbL; coastline source: https://osmdata.openstreetmap.de/data/land-polygons.html.
The bounds must contain all candidate journeys with a margin. Pass the resulting
physical mask—not either prefecture file—to `--water-land-geojson`.

`scripts/run_japan_water_routing_when_ready.ps1` connects mask preparation to
routing in an arbitrary Runner workspace. It waits for the mask report, refuses
unusable water areas or a hash mismatch, routes a separate demand copy, and runs
the conservation audit. Its output is not installed automatically. Both the
mask report and routing/audit logs must be reviewed before publication.

Malformed OSM areas are not silently accepted. `routing.inspect_water_areas`
prints their original source records; `routing.repair_water_sources` can rebuild
specified outer/inner way rings from the same fingerprinted PBF and patch only
affected mask pieces. Japan's two known source repairs are declared in
`worlds/japan/sources/water-area-repairs.json`, not hardcoded in the router.
The original mask is preserved, and the repaired mask receives a new hash and
provenance report before it can pass the routing handoff gate.

```powershell
$env:PYTHONPATH = 'src'
python -m open_world_map_creator plan --world ..\worlds\japan --tile JP_PREF_11
python -m open_world_map_creator build --world ..\worlds\japan --tile JP_PREF_11 --runner subprocess
```

Runner profiles select where and how the same immutable stage manifest executes.
The built-in `in-process` and `subprocess` adapters are contract-tested for
equivalent results; additional local or remote transports belong in Runner
adapters, not World Definitions.

`build` fails closed for unresolved source locks and for stages whose real inputs
have not been materialized. `publish` accepts only a run whose package output and
validation gates are complete.

## Japan demand and routing workers

The boundary referenced by a World Definition is authoritative for demand
ownership. Source mesh mass is assigned to building centers from the selected
Tile Package and merged at the World-configured radius. Sites that still fail
the rendered-boundary audit are diverted to the cross-tile ledger; the worker
never edits the render geometry or snaps failed demand onto a boundary edge.
Reports and JSONL progress record the building placement and ownership audit.

```powershell
$env:PYTHONPATH = 'src'
python -m open_world_map_creator.demand.japan_prefecture_queue `
  --raw-root <estat-od-root> `
  --boundary-source ..\worlds\japan\geography\prefectures.geojson `
  --output-root <output-root> `
  --progress-jsonl <queue-progress.jsonl>

python -m open_world_map_creator.routing `
  --catalog <tile-catalog.json> `
  --maps-dir <maps-tiles-root> `
  --demand-dir <demand-root> `
  --report-namespace tokyo-kanagawa `
  --consumer-manifest-id local.tokyo-kanagawa-open-world `
  --progress-jsonl <routing-progress.jsonl>
```

Both commands accept arbitrary filesystem locations. The prefecture queue is
sequential and resumable; by default it processes the 45 prefectures outside the
dedicated Tokyo/Kanagawa rebuild. Routing uses an input fingerprint so a staged
resume is discarded automatically when its map, catalog, or demand inputs have
changed.

For national OSRM routing, prepare a versioned MLD graph once and give routing a
durable SQLite cache outside the demand package:

```powershell
.\scripts\prepare_japan_osrm.ps1 -OsrmRoot <osrm-data-root>
$dataset = Get-Content -Raw <osrm-data-root>\dataset.json | ConvertFrom-Json
python -m open_world_map_creator.routing `
  --catalog <tile-catalog.json> `
  --maps-dir <maps-tiles-root> `
  --demand-dir <demand-root> `
  --report-namespace japan-national `
  --consumer-manifest-id local.japan-open-world `
  --routing-provider osrm `
  --osrm-dataset-id $dataset.datasetId `
  --osrm-cache <routing-cache-root>\osrm-routes.sqlite3 `
  --osrm-workers 16 `
  --max-routed-direct-metres 3000000 `
  --progress-jsonl <routing-progress.jsonl>
```

The cache key includes the OSRM dataset/profile, routing fallback policy, and
both coordinates at 1e-7 degree precision. Each completed one-to-many request is
committed immediately. A crash can therefore resume without repeating finished
queries. Moving a demand point changes only cache keys that touch that point;
combine this automatic coordinate invalidation with the existing invalidation
sidecar to rewrite only the affected cohorts and cross-tile partitions. Changing
the OSRM dataset ID intentionally invalidates the complete cache without deleting
older entries.

Passenger ferries can repair OSRM `NoRoute` pairs without changing the car graph
or invalidating successful road routes. Install the `ferries` extra and extract
a catalog from the same PBF used to prepare OSRM:

```powershell
python -m open_world_map_creator.routing.ferry_catalog `
  --pbf <osrm-data-root>/japan-latest.osm.pbf `
  --output <routing-cache-root>/passenger-ferries.json
```

Add `--passenger-ferry-catalog <catalog.json> --ferry-transfer-seconds 300` to
the OSRM routing command (or `-PassengerFerryCatalog` / `-FerryTransferSeconds`
to the PowerShell launcher). Completed road pairs remain in the existing cache;
ferry results and unsuccessful attempts use a separate table in that database.
The ferry cache stores the individual drive, sailing, and rideshare legs and
includes catalog, dataset, endpoint, and transfer-policy identities. Re-running
publication reads successful road pairs from cache and only computes new ferry
attempts. Changing the catalog or a demand coordinate invalidates those attempts.

Terminal access follows mapped walking connections up to 1500 m (four expansion
passes) and requires the connected road to snap within 20 m of OSRM. No artificial
water crossings are introduced. Ferry direction and passenger-access exclusions
are respected. Way durations are used when available; other sailings explicitly
use an estimated 5 km/h. A relation duration is never copied onto every member
way. Missing/incomplete mapped ferry or terminal connections remain unresolved.
The 300-second transfer applies upon leaving a ferry for a road leg, including
the final rideshare. Sailing segments split into several OSM ways do not incur
extra transfers. Timetable waiting and ticket prices are not modeled. The game
still receives aggregate time/distance and uses its existing distance-based cost;
accurate ferry/rideshare monetary costs require a separate mode-choice change.

An optional **synthetic straight-water fallback** handles pairs still marked
`NoRoute` after roads and (when configured) passenger ferries. Add:

```powershell
  --water-land-geojson <full-detail-wgs84-land-mask.geojson> `
  --water-max-access-metres 1500
```

The PowerShell routing launchers accept `-WaterLandGeojson` and
`-WaterMaxAccessMetres`. Execution location remains a Runner choice. No runtime
mode is added: the output is still aggregate `drivingSeconds`/`drivingDistance`.

For each remaining failed pair, the planner finds the point on the current
landmass nearest the final destination, routes to it on OSRM roads, and crosses
water along a straight line toward the destination at **5 km/h**. At the first
intervening landfall it stops the water segment, routes across that landmass
toward its shore nearest the destination, and re-aims the next water crossing.
This is a bounded greedy approximation, not an optimal path or a real ferry
service. Straight lines and nearest shores use a regional azimuthal-equidistant
projection; segment lengths use WGS84 geodesic distances. There is no additional
synthetic transfer penalty. The base game's existing driving cost still applies
to aggregate distance; this does not supply a boat fare.

The mask is a regional WGS84 Polygon/MultiPolygon GeoJSON (or FeatureCollection)
covering **all** possible landfalls, including small islands and inland-water
holes. Use physical land geometry, not administrative/render boundaries. The
current `worlds/japan/geography/prefectures.geojson` is deliberately rejected:
its display metadata records filled inland water and removed islands. Land
coverage outside the supplied polygons is assumed to be water, so clipped or
incomplete masks must not be used. No islands or holes are simplified away by
the router, and touching land polygons are dissolved before planning.

At each land-leg endpoint the eight nearest OSRM candidates are considered.
Access connectors must stay on that same landmass and be within the configured
limit; their time is charged at 1.4 m/s. Only successful directed OSRM routes
between accepted candidates are used. Unreachable roads, out-of-mask demand
points, same-landmass failures, or nonprogressing paths stay unresolved with an
explicit reason; they are never silently replaced with high-speed straight
lines across land. An OSRM service error aborts the run instead of being cached
as missing connectivity. Demand positions and mass are unchanged.

`straight_water_cache` stores positive and negative attempts, endpoint identities,
and component times/distances/coordinates. Keys include the backend fingerprint,
mask contents, routing version, access policy and endpoints. Road, nearest-road,
and passenger-ferry caches remain separate and reusable. Progress emits mask
loading, road legs and completed-pair counts. Successful road/ferry results bypass
the fallback. Cross-tile publication checks actual endpoints even when the
partition samples contain only mainland routes; repaired water times are never
scaled using a prefecture-pair average. This may require additional cached OSRM
queries for cross cohorts that were previously represented only by samples.

Run against a separate copy of completed demand, inspect unresolved reasons and
component accounting in the cache, and compare source/output demand before
publishing. Enabling the fallback does not itself rebuild or install a mod.

When a placement repair moves only a known set of endpoints, preserve completed
work by producing a filtered invalidation sidecar and passing it to routing:

```powershell
python -m open_world_map_creator.routing.grid_repair `
  --demand-dir <completed-demand-root> `
  --output-dir <repaired-demand-root> `
  --catalog <tile-catalog.json> `
  --maps-dir <maps-tiles-root> `
  --invalidation <grid-invalidation.json.gz>

python -m open_world_map_creator.routing `
  --catalog <tile-catalog.json> `
  --maps-dir <maps-tiles-root> `
  --demand-dir <repaired-demand-root> `
  --report-namespace japan-national `
  --consumer-manifest-id local.japan-open-world `
  --invalidation <repaired-demand-root>/reports/japan-national-grid-repair-routing-invalidation.json
```

The repair never overwrites its source package. It leaves endpoints without a
nearby building untouched, requires native replacements to remain inside their
rendered owner, and assigns each moved endpoint a unique building center.
