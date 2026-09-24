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

The current footprint contains 59 tiles. The latest expansion adds a one-cell
ring, including diagonals, around the previous 36-tile footprint where the 2023 LODES
crosswalk and OD files show home workers. Twenty-three cells qualify; fourteen adjacent
cells have no Census crosswalk blocks or intersection with the 2024 Census state
boundaries and were omitted. The evidence is recorded
in `worlds/nec-corridor/geography/expansion-evidence.json`. Grid `(0, -2)` (`NEC_CP00_RM02`)
adds Brigantine and the adjacent New Jersey coast, joining its western neighbor
at `(-1, -2)` and northern neighbor at `(0, -1)`. Grid `(3, 0)`
(`NEC_CP03_RP00`) contains the eastern portion of Block Island. The authoritative runtime
catalog is `worlds/nec-corridor/geography/tile-views.json`; the prototype selection
and generated catalog carry the same footprint for map and demand compilation.

The attached selection is in `input/nec-corridor-selection.json` and validated against the New York grid contract. The catalog compiler generates 59 tile views, optional Census state-intersection metadata, and a GeoJSON coverage layer.

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

The original workplace-led inventory is in `generated/reports/nec-lodes-inventory.json`. It covered the prior 34-tile footprint and conserved all 29,499,358 input rows / 32,291,113 workers with zero classification delta. `main` and `aux` remain separate in the report for provenance; workplace states outside this footprint are intentionally excluded.

To generate the map-only demand set, run `inventory-lodes` with the 14 state crosswalk, `main`, and `aux` mappings from `raw-data/lodes`, adding `--map-only`. That retains only OD pairs whose home and workplace blocks both land in the 59 selected tiles. The completed report is `generated/reports/nec-lodes-map-demand.json`: 24,713,828 retained rows / 27,047,629 workers, with 4,785,530 rows / 5,243,484 workers excluded by the map boundary.

The compact tile metrics and internal tile-pair export are generated with:

```powershell
python -m nec_world_builder.cli build-metrics
```

This writes `generated/reports/nec-tile-metrics.json` and `generated/reports/nec-tile-pairs.csv`. The metrics reconcile to 27,047,629 home workers and 27,047,629 workplace workers across all 59 tiles; cross-tile inbound and outbound totals each reconcile to 7,635,196 workers.

The current tests cover export validation, half-open tile assignment, catalog neighbors, acquisition-manifest expansion, mutually exclusive `main`/`aux` classification, and map-only filtering. Auxiliary files from workplace states outside the NEC grid are intentionally out of scope.

## M4: Subway Builder map packages

M4 packages the map-only demand and Depot assets using the same contract as the NY canary. The demand compiler writes one package per selected tile under `generated/demand/`, including `demand_data.json.gz`, `cross_commutes.json`, `cross_demand.json.gz`, and a manifest. The completed demand report is `generated/demand/reports/nec-demand.json`.

The Depot runner downloads the 14 official Geofabrik OSM extracts, uses OSM building multipolygons instead of the optional Overture building catalog, and writes the Subway Builder map assets under `generated/maps/tiles/<tile-id>/`. Each tile contains the compressed building index, roads, runways/taxiways, PMTiles, and `map-manifest.json`. After Depot finishes, the build follows the original NY canary and splices pinned Natural Earth 10m land, lakes, and country boundaries at zooms 0–9 into every archive while retaining local Depot detail at zooms 10–15. The unmodified archive remains as `tiles.city-only.pmtiles`; candidate archives are verified and probed outside the NEC footprint before replacement. The map run is resumable through per-tile benchmark markers:

```powershell
& .\prototype\nec-corridor\build-nec.ps1
```

Use `-SkipDownloads`, `-SkipDemand`, or `-SkipDepot` to resume a specific phase. To run a single tile, pass `-Tile NEC_CM01_RM01`; the wrapper forwards that filter into Docker. OSM source provenance is recorded in `config/osm.sources.json`, and the Depot summary is `generated/maps/reports/nec-depot.json`.

### Driving routes

The published 59-tile demand uses the pinned NEC OSRM driving dataset. The
routing stage preserves every native and cross-tile cohort while adding driving
time and distance, then stores route geometry in per-tile archives for the
game's `map://paths/<city>/<popId>` requests. The publication steps, data
checks, and fallback policy are in [`docs/nec-routing-publication.md`](../../docs/nec-routing-publication.md).

## Mod scaffold

`mod/` is the NEC adaptation of the original NY mod. It registers all 59 selected tiles with the same world-tile runtime, keeps the NEC world identity separate from NY saves, embeds the world-level cross-tile demand catalog, and serves each tile's PMTiles archive through the native directory server.

The build step stages map, demand, and route geometry sources into the game-facing package layout:

```powershell
Push-Location .\prototype\nec-corridor\mod
npm run build
npm run install:mod
Pop-Location
```

For the installed `northeast-corridor-open-world` release identity, use
`npm run build:release` followed by `npm run install:release` from the same
mod directory. Both commands use the current shared `open-world-platform`
implementation and the selected NEC Tile Packages.

`npm run build` waits until every selected tile has its demand, Depot map, and
route geometry packages. It stages them under `generated/mod/tiles/` and builds
the runnable bundle in `mod/dist/`. The install commands copy changed packages
into the game city-data directory and register NEC with the official shared
PMTiles service on port `8799`.
