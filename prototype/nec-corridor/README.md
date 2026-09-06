# Northeast Corridor tile desk

This is a standalone, no-build interactive selector for planning the next open-world mod footprint.

Open [`logic-prototype.html`](logic-prototype.html) directly in a browser with an internet connection. It uses OpenStreetMap's standard raster tiles as the background, with only the selectable tile grid over it. Every cell can be toggled independently, the selection is saved in local browser storage, and **Export** downloads the selected tile IDs and grid metadata as JSON.

The grid intentionally reuses the New York canary contract:

- EPSG:26918
- origin `(553400, 4483300)` metres
- ownership cells `77,700 × 97,300` metres
- 2 km immutable-data halo
- half-open ownership bounds
- tile IDs use the existing `C[MP]## / R[MP]##` convention with an `NEC_` world prefix

The background uses [OpenStreetMap](https://www.openstreetmap.org/) tiles and displays the required attribution. The tile polygons are converted from the NY canary's EPSG:26918 coordinates to WGS84 before Leaflet places them on its Web Mercator map, so Virginia, Washington, DC, Baltimore, Philadelphia, New York, and Boston sit in their geographic positions. See the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) for the service requirements.

## Implementation started

The attached selection is now copied to `input/nec-corridor-selection.json` and validated against the New York grid contract. The first compiler slice generates a 34-tile catalog, optional Census state-intersection metadata, and a GeoJSON coverage layer.

From the repository root:

```powershell
$env:PYTHONPATH = (Join-Path (Get-Location) 'prototype/nec-corridor/src')
python -m nec_world_builder.cli build-catalog `
  --selection prototype/nec-corridor/input/nec-corridor-selection.json `
  --boundary .analysis/cb_2024_us_state_500k.zip
```

The streaming inventory command is ready for the LODES `main` and `aux` files once the state downloads are acquired:

```powershell
python -m nec_world_builder.cli inventory-lodes `
  --selection prototype/nec-corridor/input/nec-corridor-selection.json `
  --crosswalk 36=path/to/ny_xwalk.csv.gz `
  --main 36=path/to/ny_od_main_JT01_2023.csv.gz `
  --aux 36=path/to/ny_od_aux_JT01_2023.csv.gz
```

## LODES acquisition and completed run

The 2023 LODES8 JT01 source set for all 14 workplace jurisdictions is acquired with:

```powershell
$env:PYTHONPATH = (Join-Path (Get-Location) 'prototype/nec-corridor/src')
python -m nec_world_builder.cli acquire-sources
```

The command is resumable: existing files are hashed and reused, while `--force` redownloads them. It writes the acquisition manifest and observed SHA-256 values to `raw-data/lodes/acquisition-report.json` and `config/sources.lock.resolved.json`.

The completed workplace-led inventory is in `generated/reports/nec-lodes-inventory.json`. It covers all 34 selected tiles and conserves all 29,499,358 input rows / 32,291,113 workers with zero classification delta. `main` and `aux` remain separate in the report for provenance; workplace states outside this footprint are intentionally excluded.

To generate the map-only demand set, run `inventory-lodes` with the 14 state crosswalk, `main`, and `aux` mappings from `raw-data/lodes`, adding `--map-only`. That retains only OD pairs whose home and workplace blocks both land in the 34 selected tiles. The completed report is `generated/reports/nec-lodes-map-demand.json`: 22,379,010 retained rows / 24,432,954 workers, with 7,120,348 rows / 7,858,159 workers excluded by the map boundary.

The compact tile metrics and internal tile-pair export are generated with:

```powershell
python -m nec_world_builder.cli build-metrics
```

This writes `generated/reports/nec-tile-metrics.json` and `generated/reports/nec-tile-pairs.csv`. The metrics reconcile to 24,432,954 home workers and 24,432,954 workplace workers across all 34 tiles; cross-tile inbound and outbound totals each reconcile to 6,627,084 workers.

The current tests cover export validation, half-open tile assignment, catalog neighbors, acquisition-manifest expansion, mutually exclusive `main`/`aux` classification, and map-only filtering. Auxiliary files from workplace states outside the NEC grid are intentionally out of scope.

## M4: Subway Builder map packages

M4 packages the map-only demand and Depot assets using the same contract as the NY canary. The demand compiler writes one package per selected tile under `generated/demand/`, including `demand_data.json.gz`, `cross_commutes.json`, `cross_demand.json.gz`, and a manifest. The completed demand report is `generated/demand/reports/nec-demand.json`.

The Depot runner downloads the 14 official Geofabrik OSM extracts, uses OSM building multipolygons instead of the optional Overture building catalog, and writes the Subway Builder map assets under `generated/maps/tiles/<tile-id>/`. Each tile contains the compressed building index, roads, runways/taxiways, PMTiles, and `map-manifest.json`. After Depot finishes, the build follows the original NY canary and splices pinned Natural Earth 10m land, lakes, and country boundaries at zooms 0–9 into every archive while retaining local Depot detail at zooms 10–15. The unmodified archive remains as `tiles.city-only.pmtiles`; candidate archives are verified and probed outside the NEC footprint before replacement. The map run is resumable through per-tile benchmark markers:

```powershell
& .\prototype\nec-corridor\build-nec.ps1
```

Use `-SkipDownloads`, `-SkipDemand`, or `-SkipDepot` to resume a specific phase. To run a single tile, pass `-Tile NEC_CM01_RM01`; the wrapper forwards that filter into Docker. OSM source provenance is recorded in `config/osm.sources.json`, and the Depot summary is `generated/maps/reports/nec-depot.json`.

### Generated-road driving-time splice

After complete map and demand artifacts exist, enrich them without rerunning
LODES aggregation, Voronoi packing, Depot, PMTiles, or unified basemaps:

```powershell
$env:PYTHONPATH = (Join-Path (Get-Location) 'prototype/nec-corridor/src')
python -m nec_world_builder.cli enrich-driving
```

The stage constructs a shortest-time graph from the already-generated
`roads.geojson.gz` files using effective speeds of 85 km/h for highways,
50 km/h for major roads, and 30 km/h for minor roads. It atomically splices the
resulting seconds and metres into native and cross-tile demand, recalculates
cross-commute summaries, and refreshes package hashes. Trips over 250 km, snaps
farther than 5 km, disconnected paths, and implausible detours retain the prior
geometric estimate. The audit report is
`generated/demand/reports/nec-road-routing.json`.

Native outputs and directed cross-tile-pair models are checkpointed in the
transactional staging directory, so an interrupted run resumes completed work.
Cross demand is partitioned by directed tile pair: up to four deterministic
road routes calibrate each partition's distance and time factors, reducing the
full NEC cross search from 57,531 paths to at most 4,348 representative paths.

### On-demand driving-route rendering

The NEC consumer also serves the game's native
`map://paths/<city>/<popId>` request for `nec-native-pop-*` and
`nec-cross-pop-*` cohorts. Native pop details and the cross-demand viewer share
one asynchronous route-path module. It loads generated `roads.geojson.gz`
partitions lazily, routes in a Web Worker with the same 85/50/30 km/h effective
speeds, and caches the two most recent road graphs.

In-tile requests start with the active tile. Cross-tile requests use the
shortest neighbor chain from the NEC tile catalog and expand that corridor by
one tile only if the first graph is disconnected. Routes over 250 km, failed
snaps, disconnected graphs, and excessive detours retain the geometric
fallback. No route graph is built until a player opens a pop path.

## Mod scaffold

`mod/` is the NEC adaptation of the original NY mod. It registers all 34 selected tiles with the same world-tile runtime, keeps the NEC world identity separate from NY saves, embeds the world-level cross-tile demand catalog, and serves each tile's PMTiles archive through the native directory server.

The build step stages the two generated sources into the game-facing package layout:

```powershell
Push-Location .\prototype\nec-corridor\mod
npm run build
npm run install:mod
Pop-Location
```

`npm run build` waits until every selected tile has both its demand package and its Depot map package. It writes staged packages to `generated/mod/tiles/` and bundles `start-tile-server.ps1` plus its native PMTiles server helper into `mod/dist/`; it does not install anything into the game. `npm run install:mod` is the explicit install step. It copies each PMTiles archive into the installed city data, launches the bundled startup script from the installed mod directory, and uses port `8799` so the NEC service does not collide with the NY canary service on `8798`.
