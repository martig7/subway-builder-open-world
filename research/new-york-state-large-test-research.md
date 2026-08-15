# New York State large-test factual basis

Research date: 2026-08-11  
Scope: choose a defensible Subway Builder NYC-sized tile footprint, count the tiles needed for New York State, and size the official LODES inputs. This note records evidence and recommendations; it does not change implementation code.

## Executive recommendation

Use a north-up **77,700 m × 97,300 m** ownership grid in **NAD83 / UTM zone 18N (EPSG:26918)** for the New York test. Anchor it at **(553,400 m E, 4,483,300 m N)**, making the installed base-game NYC data envelope tile `(0,0)`. Keep the current 2 km processing halo outside ownership bounds.

That grid produces:

| Coverage rule | Tile count | Intended use |
| --- | ---: | --- |
| Every cell in New York's rectangular state bounding box | **63** | A simple rectangular atlas; wasteful because it includes large areas outside the state. |
| Any intersection with the official 2024 Census 1:500,000 cartographic New York boundary | **35** | Conservative package-generation maximum. |
| More than 1 km² of boundary overlap | **33** | Recommended substantive test set; the other two intersections are sub-0.1 km² shoreline/boundary slivers. |
| More than 500 km² of boundary overlap | **30** | An aggressive pruning option, but it drops narrow edge areas and is not recommended for a correctness test. |

The proposed first statewide build should therefore create **33 normal tile packages plus two addressable empty/sliver tile records**. This preserves a rectangular, deterministic grid without paying full map-generation cost for numerical slivers. The atlas can omit all 28 bbox cells that do not intersect New York.

For demand, use **LODES8 2023, JT01 Primary Jobs**, with New York `main`, New York `aux`, and the New York block crosswalk. The exact measured official input is **51,371,078 bytes compressed (49.0 MiB)** and **619,723,352 bytes extracted (591.0 MiB)** across **7,801,578 OD rows** plus **288,819 crosswalk rows**. WAC/RAC `S000 JT01` files are optional validation summaries, not inputs to OD reconstruction.

## 1. What "the size of the base NYC map" can mean

Subway Builder does not expose a documented `bounds` property for a city. The official custom-city API defines an initial longitude, latitude, zoom, optional bearing, and `minZoom`, then separately associates demand, building, road, and map-tile assets; it does not define a hard gameplay rectangle ([Custom Cities API](https://www.subwaybuilder.com/docs/api-reference/cities)). The installed 1.6.0 bundle likewise defines NYC at longitude `-74`, latitude `40.7128`, zoom `13.5`, bearing `29`, and `minZoom: 9`, but has no city bounds (`research/bundle-inspect-1.6.0/dist/renderer/public/index-BCLhXOq-.js`, lines 89070–89084).

Consequently, “NYC map size” must be an asset-footprint convention. The installed first-party NYC assets are under:

`C:\Users\darkd\AppData\Roaming\metro-maker4\cities\data\NYC`

Their measured envelopes are:

| Asset | WGS84 bounds `[west, south, east, north]` | Interpretation |
| --- | --- | --- |
| `roads.geojson.gz` | `[-74.3612029473, 40.4983352, -73.4526297656, 41.365957]` | Best proxy for the playable simulation footprint; roads support routing and collision behavior. |
| `demand_data.json.gz` | `[-74.356563, 40.500732, -73.456527, 41.351139]` | Slightly inset from roads, as expected for populated demand. |
| `foundations.pmtiles` header | `[-74.36167, 40.49843, -73.45451, 41.35524]` | Independently corroborates approximately the same dense simulation footprint. |
| `tiles.pmtiles` header | `[-74.608154, 40.241536, -73.125, 41.604148]` | Much larger visual/context envelope; not a good ownership-tile size because a PMTiles pyramid normally includes surrounding context and tile-boundary padding. |

The roads envelope measures approximately **76.52 km east-west × 96.35 km north-south** along its midlines using WGS84 geodesics. Transforming all four bbox corners to EPSG:26918 gives a containing projected envelope of **77,694.7 m × 97,272.2 m**. Transforming the actual road vertices produces a slightly smaller axis-aligned extent, **76,936.3 m × 96,691.9 m**, because the WGS84 rectangle is mildly rotated/warped in UTM.

The recommended **77,700 × 97,300 m** cell uses the containing-corner dimensions. It therefore preserves the whole first-party road envelope and avoids falsely precise millimetre-scale boundaries.

### Why not use the visual-tile PMTiles bounds?

Using `tiles.pmtiles` would define a roughly 125 × 151 km cell and make the answer depend on vector-tile packaging rather than the game simulation's data extent. The Custom Cities API explicitly treats tile URLs and city data files as separate registrations ([Custom Tiles and City Data Files](https://www.subwaybuilder.com/docs/api-reference/cities)). Roads/demand/foundations agree on the tighter footprint, so they are the defensible ownership boundary.

## 2. Grid alignment and New York tile count

### Recommended grid contract

```text
crs: EPSG:26918
origin_x: 553400
origin_y: 4483300
tile_width_m: 77700
tile_height_m: 97300
ownership convention: [min_x, max_x) × [min_y, max_y)
halo_m: 2000
tile id: NY_<signed column>_<signed row>
NYC base tile: column 0, row 0
```

The integer-metre origin is within tens of metres of the transformed southwest corner of the installed road envelope `(553,425.7, 4,483,265.9)`. That rounding is negligible relative to the halo and keeps generated manifests legible. The half-open ownership convention prevents a boundary point from belonging to two tiles.

EPSG:26918 is preferable for this test because the existing Kansas City pipeline already assumes a single projected metre CRS, and the base NYC footprint lies in zone 18. Western New York extends into nominal UTM zone 17, so EPSG:26918 is not the eventual national grid. It is still a practical statewide-test projection; a later nationwide product should adopt a continental projection and a separate stable global tile key rather than extending this state test unchanged.

### Count method

1. Download the official Census 2024 national 1:500,000 state cartographic boundary, `cb_2024_us_state_500k.zip`, from the [2024 Cartographic Boundary Files page](https://www.census.gov/geographies/mapping-files/2024/geo/carto-boundary-file.html). Census describes these files as simplified boundaries clipped to a simplified U.S. outline ([Cartographic Boundary Files ReadMe](https://www2.census.gov/geo/tiger/GENZ2024/description.pdf)).
2. Select state `STUSPS = NY` and project its geometry to EPSG:26918.
3. Enumerate every 77,700 × 97,300 m grid cell between the state's minimum and maximum grid indices.
4. Count cells with a positive polygon-intersection area, then report thresholds to expose shoreline slivers.

The cartographic boundary's projected envelope is approximately `(105,621, 4,483,095)` to `(764,109, 4,985,490)` metres. Grid indices span columns `-6..2` and rows `-1..5`, hence **9 × 7 = 63 bbox cells**. Of those, **35** intersect the cartographic state geometry; **33** overlap it by more than 1 km². This count includes Long Island and New York's disconnected/island geometry because intersection is against the complete state multipolygon.

For scale, the full TIGER/Line state record reports `ALAND = 122,049,155,860 m²` and `AWATER = 19,256,755,462 m²`. One proposed cell is 7,560.21 km², so land area alone is only **16.1 tile-equivalents**. The larger 33-tile count is expected: New York is long, irregular, and diagonal relative to a fixed rectangular grid. The [TIGER/Line technical layouts](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2024/TGRSHP2024_TechDoc_F-S.pdf) define `ALAND` and `AWATER`; the 1:500,000 geometry is appropriate for planning, not cadastral inclusion decisions.

### Alignment uncertainty

Changing the origin or using the actual-road-vertex extent instead of the containing WGS84 bbox changes tiny-edge counts: the tested variants produced 35–36 positive intersections and 33–34 intersections above 1 km². **Thirty-three substantive tiles is stable; the exact number of numerical slivers is not.** Freeze the origin and intersection threshold in versioned configuration before generating assets.

## 3. Official New York LODES inventory

The current official release is LODES8 2023. The [LODES 8.4 technical documentation](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf) defines `JT00` as All Jobs and `JT01` as Primary Jobs, and identifies `S000` as the total number of jobs in OD records. The project's existing Kansas City pipeline uses JT01 to represent one primary-job commute rather than potentially counting a worker's secondary jobs.

Use these three required files:

| File | Purpose | Compressed bytes | Extracted bytes | Data rows |
| --- | --- | ---: | ---: | ---: |
| `ny_od_main_JT01_2023.csv.gz` | Workplace and residence are both in New York | 41,054,012 | 430,400,307 | 7,055,595 |
| `ny_od_aux_JT01_2023.csv.gz` | Workplace is in New York; residence is outside New York | 5,107,362 | 45,505,366 | 745,983 |
| `ny_xwalk.csv.gz` | 2020 block IDs, representative coordinates, and geography lookup | 5,209,704 | 143,817,679 | 288,819 |
| **Total** |  | **51,371,078** | **619,723,352** | **8,090,397** |

The OD subset alone has **7,801,578 nonzero home/work block pairs**. These exact values were measured by streaming the official gzip files and counting decompressed bytes/newlines. The published Census directory rounds the same files to 39M, 4.9M, and 5.0M respectively ([NY OD directory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/od/), [NY state directory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/)). Decompressed SHA-256 values measured for reproducibility are:

```text
main  45c4ee6bfd1e72b960d4ede294b8b64945cb88ca8575d576f5b681d1c6bd9de6
aux   867ac50eb3e49112158f8210d3cb3ffbb313c469e64c533d0f90fb9160b1964e
xwalk ffa31ac83f3940f755440a404ade5a70e782ae9c68d6e50f4ced8f3df705a0ed
```

Optional validation files are `ny_wac_S000_JT01_2023.csv.gz` (**2.6M** published compressed) and `ny_rac_S000_JT01_2023.csv.gz` (**5.8M**). WAC validates workplace totals and RAC validates residence totals, but neither replaces OD `main + aux`, which preserves pairings. Their official inventories are the [NY WAC directory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/wac/) and [NY RAC directory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/rac/).

### Interstate scope limitation

New York `aux` captures people living outside New York who work inside it. It does **not** capture New York residents whose workplace is outside New York, because LODES assigns OD records to the workplace state. A strictly New-York-state test can either:

- intentionally model only jobs located in New York and document that boundary condition; or
- additionally stream neighboring states' `aux` files and retain rows whose home block is in New York.

The second option is required before claiming complete cross-state commute conservation, but it is not required to test 33–35 in-state map tiles.

## 4. Disk and memory implications

### Installed NYC tile is a dense upper-bound reference, not a multiplier

The installed non-dotfile NYC assets total **308,067,314 bytes (293.80 MiB)**:

| Asset | Installed size |
| --- | ---: |
| `tiles.pmtiles` | 164.10 MiB |
| `buildings_index.bin.gz` | 71.40 MiB |
| `foundations.pmtiles` | 44.72 MiB |
| `roads.geojson.gz` | 8.30 MiB |
| all remaining assets, including demand | 5.28 MiB |

Blindly multiplying that dense NYC package by 35 gives **about 10.0 GiB**. That is a deliberately pessimistic ceiling, not a forecast: upstate tiles have far fewer buildings and roads, and visual basemap/foundation tiles should be stored once in a statewide PMTiles archive rather than duplicated in each simulation package. The installed `tiles.pmtiles` alone accounts for 56% of the NYC package.

The existing national feasibility note records the installed NYC collision index at 1,368,300 buildings and the base demand at 12,096 points / 34,794 pops. New York State preprocessing will be driven much more by **7.8 million raw OD pairs** than by compressed download bytes. The correct pipeline remains:

1. keep the 49 MiB Census gzip archive immutable;
2. stream OD rows through a disk-backed crosswalk;
3. spatially aggregate and split cohorts under the project's 50-minimum/200-maximum rules;
4. partition points/cohorts by ownership tile and cross-tile flows by stable endpoint IDs;
5. load only the active tile's native demand and a compact statewide cross-tile index.

Do not allocate one JavaScript object per raw OD row: even a minimal 100-byte-per-row object allowance would exceed 780 MB before indexes, strings, aggregation state, or the game's native data. The raw CSV is an offline input, not a runtime representation.

### Practical capacity target for this test

A defensible initial budget is:

- **Disk:** 15 GiB free working space for the Census archive, extracted/columnar intermediates, routing graph, statewide PMTiles, collision generation, and temporary files. The final installed product should be materially smaller; measure rather than commit to a size before generation.
- **Renderer RAM:** keep the active native city package plus prefetch data under the existing 250–500 MB working-set target. Cross-tile statewide demand must stay packed or aggregate until selected.
- **Package count:** 33 populated + 2 empty/sliver manifests, never 63 indiscriminate bbox builds.

## 5. Proposed large-test stages

1. **Freeze geometry.** Add the EPSG:26918 origin/cell dimensions and Census boundary source/hash to a New York world config. Emit 35 catalog entries, marking two as empty/sliver after the >1 km² rule.
2. **Inventory before building.** Stream the three LODES files and report rows/workers by home tile, work tile, local pair, cross-tile pair, and out-of-state endpoint. This is the first mass-conservation gate.
3. **Generate a four-tile dense corridor first.** NYC, the immediately north tile, the Long Island/east tile, and the west/northwest neighbor exercise dense data and multiple boundaries without waiting for the state.
4. **Generate the remaining statewide packages.** Use one statewide visual PMTiles archive where possible and per-tile collision/road/demand assets with halos.
5. **Runtime test.** Measure cold/warm tile-switch p50/p95, renderer working set, checkpoint size, day-update duration, cross-tile mode-choice time, and fare conservation across at least ten autosaves.

## 6. Key uncertainties

- **No official hard NYC rectangle exists.** The 77.7 × 97.3 km choice is an evidence-based convention derived from the installed first-party simulation assets.
- **Cartographic intersection is approximate.** The 1:500,000 boundary is intentionally generalized. Use it to select build tiles, then clip actual OSM/LODES features against exact ownership rectangles.
- **Neighbor-state commuters are incomplete with NY files alone.** A later complete region needs relevant auxiliary rows from surrounding workplace states.
- **Final package size cannot be inferred from raw gzip size.** Building density, OSM geometry, routing graph detail, driving-route representation, halo duplication, and cohort aggregation dominate.
- **One statewide projection is a test convenience.** EPSG:26918 is suitable for this test and matches NYC, but should not become the national grid without a separate projection decision.

## Source ledger

- Installed Subway Builder 1.6.0 bundle: `research/bundle-inspect-1.6.0/dist/renderer/public/index-BCLhXOq-.js`, NYC definition at lines 89070–89084.
- Installed first-party NYC city package: `C:\Users\darkd\AppData\Roaming\metro-maker4\cities\data\NYC`.
- [Subway Builder Custom Cities API](https://www.subwaybuilder.com/docs/api-reference/cities).
- [Census LODES8 New York directory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/) and [OD inventory](https://lehd.ces.census.gov/data/lodes/LODES8/ny/od/).
- [LODES 8.4 technical documentation](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf).
- [Census 2024 Cartographic Boundary Files](https://www.census.gov/geographies/mapping-files/2024/geo/carto-boundary-file.html) and [description](https://www2.census.gov/geo/tiger/GENZ2024/description.pdf).
- [Census 2024 TIGER/Line archive](https://www2.census.gov/geo/tiger/TIGER2024/) and [technical layouts](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2024/TGRSHP2024_TechDoc_F-S.pdf).
- Existing project sizing context: `research/us-lodes-national-map-feasibility.md`.
