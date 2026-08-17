# Northeast Corridor LODES demand-map plan

Status: plan only; no demand compiler or map-layer code is implemented by this document.

Purpose: turn the exported Northeast Corridor tile selection into a demand map and, later, tile demand packages using the same grid, conservation, and aggregation rules proven by the New York State prototype.

The attached selection is `C:\Users\darkd\Downloads\nec-corridor-selection (5).json`. The official-data findings are recorded in [LODES research notes](../prototype/nec-corridor/LODES-research-notes.md). The prior implementation and its invariants are in the [New York State plan](new-york-state-large-test-plan.md).

## 1. Starting contract

Treat the export as a selection manifest, not as a complete tile catalog. It contains 34 selected tile IDs and the ownership bounds needed to rebuild the catalog.

| Property | Exported decision |
| --- | --- |
| Schema | `0.1.0` |
| World | `NEC_CORRIDOR_TILE_PLANNER` |
| CRS | `EPSG:26918` |
| Grid origin | `(553400, 4483300)` metres |
| Ownership cell | `77,700 × 97,300` metres |
| Ownership bounds | `[min_x,max_x) × [min_y,max_y)` |
| Immutable-data halo | `2,000` metres |
| Selected tiles | `34` |
| Tile IDs | `NEC_C[MP]##_R[MP]##` |

Keep this grid unchanged for the Northeast prototype. It is the same physical grid used by the New York map, so existing projection, tile assignment, halo, and cohort tests can be reused. Do not infer tile geometry from the OSM basemap or from LODES administrative boundaries.

The selected ownership rectangles touch these jurisdictions according to the 2024 Census state geometry:

| Jurisdiction | Selected-tile touches |
| --- | ---: |
| CT | 6 |
| DC | 2 |
| DE | 5 |
| MA | 10 |
| MD | 10 |
| ME | 3 |
| NH | 5 |
| NJ | 7 |
| NY | 10 |
| PA | 9 |
| RI | 3 |
| VA | 6 |
| VT | 2 |
| WV | 2 |

The counts overlap because one tile can touch multiple jurisdictions. They are used to determine the first workplace-state download set, not to rename or split tiles.

## 2. Important LODES interpretation

Use one LODES 8.4 release, 2023, `JT01` Primary Jobs, and `S000` as the first demand measure. The official [LODES technical documentation](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf) defines the OD files as workplace-state partitions:

- `main`: workplace and residence are both in the file's state;
- `aux`: workplace is in the file's state and residence is outside that state.

Therefore, `main + aux` for the 14 jurisdictions touched by the map is sufficient for a workplace-led map of jobs located in the selected footprint. It is not sufficient for a complete map of residents of the footprint who work elsewhere. Those outbound residents appear in the `aux` files of their destination workplace states. Census’s [main/auxiliary code examples](https://lehd.ces.census.gov/data/lehd-code-samples/sections/lodes/basic_examples.html) document this asymmetry.

The plan has two explicit scopes:

1. **Workplace-led first map — recommended first milestone.** Download `main` and `aux` for the 14 touched jurisdictions. This measures jobs in selected tiles, including workers arriving from outside the workplace state.
2. **Complete selected-resident view — required before claiming complete commute demand.** Add `aux` files for all other workplace states and retain rows whose residence block maps into one of the 34 selected tiles. This captures selected-tile residents working outside the corridor. Do not silently call the first milestone a complete resident-demand map.

Do not add `main` and `aux` together as two populations. They are complementary OD partitions, and each retained row should contribute its `S000` mass once.

## 3. Source acquisition

Create a NEC source lock modeled on `prototype/ny-state/config/sources.lock.json`. Every source entry should record URL, state, workplace role, LODES format/version, year, byte count, compressed and decompressed hashes when available, retrieval date, and the source checksum/version files.

### Minimum first-milestone inputs

For each of `ct, dc, de, ma, md, me, nh, nj, ny, pa, ri, va, vt, wv`:

- `[st]_od_main_JT01_2023.csv.gz`;
- `[st]_od_aux_JT01_2023.csv.gz`;
- `[st]_xwalk.csv.gz`.

The official [LODES distribution index](https://lehd.ces.census.gov/data/lodes/LODES8/) and state directories are the source of truth. Download the crosswalks for every selected residence jurisdiction even when the state is only needed as an auxiliary workplace file: an `aux` row can carry a residence block outside the workplace state.

### Complete resident-side inputs

Add `[st]_od_aux_JT01_2023.csv.gz` for the remaining workplace states. The minimum crosswalk set remains the 14 selected residence jurisdictions if the outside endpoint is only stored as a destination state. Add all state crosswalks if the map will show external destination tiles or state-to-state flow geometry.

Optional WAC and RAC `S000 JT01` files are validation inputs only:

- WAC checks workplace-side totals;
- RAC checks residence-side totals;
- neither preserves the home/work pairing, so neither replaces OD `main + aux`.

## 4. Pipeline stages

### NEC-0 — Import and freeze the selection

1. Parse the attached JSON as untrusted data, validate the schema, world ID, CRS, grid dimensions, half-open ownership convention, and 34 unique selected IDs.
2. Recompute each ID's projected bounds from `(column,row)` and require an exact match to `ownershipProjected`.
3. Build a generated NEC catalog with stable IDs, columns, rows, ownership bounds, 2 km halos, WGS84 display bounds, neighboring selected tiles, and state-intersection metadata.
4. Use the 2024 Census state geometry only to describe coverage and package status. Keep the exported tile selection authoritative.
5. Emit `nec-tile-catalog.json`, a GeoJSON coverage layer, and a human-readable selection report before downloading LODES.

### NEC-1 — Build endpoint lookup tables

1. Stream each required state crosswalk into a disk-backed lookup keyed by the 15-character `tabblk2020`/block GEOID.
2. Keep `blklondd` and `blklatdd` as WGS84 internal-point coordinates. Census cautions that these are internal points, not block centroids or addresses.
3. Transform each endpoint to `EPSG:26918` and assign it with the exact half-open grid rule.
4. Store the source state FIPS, source crosswalk vintage, projected coordinates, assigned NEC tile ID or an explicit `OUTSIDE_SELECTED_TILES` value.
5. Preserve unresolved geocodes in a reject ledger rather than dropping them from the conservation calculation.

### NEC-2 — Stream and classify OD demand

Read gzip CSVs in bounded batches; do not create one Python or JavaScript object per raw OD row. The New York prototype’s `inventory.py` and `pilot_demand.py` are the implementation model.

For every retained row, keep `source_workplace_state`, `main|aux`, `createdate`, `h_geocode`, `w_geocode`, and `S000` until the classification and validation gates pass.

| Category | Definition | Runtime treatment |
| --- | --- | --- |
| `local` | home and work both map to the same selected tile | Native tile-local demand candidate |
| `corridorCrossTile` | both endpoints map to selected tiles, but to different tiles | One canonical cross-tile flow; never duplicate as two local populations |
| `externalInbound` | work endpoint maps to a selected tile; home endpoint is outside the selected footprint | Workplace-side boundary inflow summary; no fake local residence |
| `externalOutbound` | home endpoint maps to a selected tile; work endpoint is outside the selected footprint | Resident-side boundary outflow summary; no fake local workplace |
| `selectedStateOutsideTile` | endpoint is in a touched state but outside the 34 selected rectangles | Keep in the boundary ledger; do not put it in a selected tile |
| `unresolved` | endpoint or crosswalk cannot be resolved | Reject ledger plus failed validation gate |

For the first workplace-led milestone, `local`, `corridorCrossTile`, and `externalInbound` are complete for the downloaded workplace-state scope. `externalOutbound` is intentionally incomplete until the all-workplace-state `aux` scan is added.

Aggregate by `(home_tile_id, work_tile_id)` while retaining the source partition. The conservation equation must be reported separately for `main`, selected-state `aux`, and the additional outside-state `aux` scan:

```text
input rows/workers
= classified rows/workers
  + selected-state-outside-tile
  + unresolved
```

Within `classified`, the named categories must be mutually exclusive and sum to the input exactly.

### NEC-3 — Produce the first demand map

Start with a simple tile-level map on top of the existing OSM map. Keep the 34 exported cell outlines and use a single metric layer at a time rather than drawing raw OD lines over the map.

Each tile record should expose:

- `workWorkers`: all `S000` workers whose workplace point is in the tile;
- `homeWorkers`: all retained workers whose residence point is in the tile;
- `localWorkers`;
- `corridorInboundWorkers` and `corridorOutboundWorkers`;
- `externalInboundWorkers` and `externalOutboundWorkers`;
- `activityWorkers = homeWorkers + workWorkers`, explicitly labeled as a double-sided activity measure rather than unique people;
- OD row counts, endpoint counts, source vintages, and unresolved/rejected mass.

The first UI should provide only:

1. `Jobs in tile` — workplace-side heatmap from `main + aux`;
2. `Residents in tile` — residence-side heatmap after the complete auxiliary scan;
3. a selected-tile count and export of the metrics.

Use a restrained sequential fill, preserve the OSM basemap, and keep exact numbers in the tile tooltip/details. Defer arrows, routes, station demand, and transit mode assumptions until the tile totals reconcile. LODES gives home/work relationships, not observed transit trips, station choices, route geometry, or mode choice.

### NEC-4 — Apply the New York aggregation contract

Only after the tile inventory passes:

1. Merge endpoint sites within `100 m` using deterministic source-derived IDs.
2. Generate local tile demand from rows whose home and work both belong to that tile.
3. Pack cohorts with the established `50–200` person range.
4. Retain unavoidable sub-50 residual cohorts with an explicit warning; do not move them across tile boundaries to satisfy a minimum.
5. Split cross-tile demand into one canonical global flow table keyed by stable endpoint/cohort IDs.
6. Store external inbound/outbound flows as boundary ledgers with source state, destination state, mass, and validation totals.
7. Keep detailed driving times/routes out of the first map. If needed later, snap aggregated sites to a pinned regional OSM router and cache the result by router version.

Native `demand_data.json.gz` should contain only local demand for the active tile. Cross-tile and external flows should be stored once in a packed, world-level index and referenced by each tile manifest; do not copy the whole NEC cross-demand table into 34 packages.

## 5. Validation gates

The build cannot produce a “ready” demand map until all of these pass:

- **Selection gate:** 34 unique IDs; projected bounds exactly match the export; no tile is silently added or removed.
- **Grid gate:** EPSG:26918, origin, width, height, half-open ownership, and 2 km halo equal the New York contract.
- **Crosswalk gate:** every selected-tile endpoint resolves to a 2020-block internal point; unresolved rows are counted and surfaced.
- **Mass gate:** `S000` worker mass is conserved within each input partition and in the combined mutually exclusive inventory.
- **Tile-pair gate:** local and cross-tile pair totals reconcile with the tile marginals.
- **Auxiliary gate:** inbound rows come from selected workplace-state `aux`; outbound rows come from destination-workplace-state `aux`; no `main`/`aux` double count.
- **WAC gate:** workplace tile totals reconcile to WAC under the same endpoint assignment and documented scope.
- **RAC gate:** residence tile totals reconcile to RAC when the complete resident-side scan is enabled.
- **Boundary gate:** points just inside and outside each ownership edge receive the expected tile ID; the halo never changes ownership.
- **Reproducibility gate:** same source locks and config produce the same tile metrics, pair CSV, point IDs, cohort IDs, and hashes.

## 6. Deliverables

### First map milestone

- `prototype/nec-corridor/config/world-nec.json` — frozen grid, selection, cohort, and LODES contract;
- `prototype/nec-corridor/config/sources.lock.json` — official source URLs and hashes;
- `prototype/nec-corridor/generated/catalog/nec-tile-catalog.json`;
- `prototype/nec-corridor/generated/coverage/nec-tile-coverage.geojson`;
- `prototype/nec-corridor/generated/reports/nec-lodes-inventory.json` and `.md`;
- `prototype/nec-corridor/generated/reports/nec-tile-metrics.json`;
- `prototype/nec-corridor/generated/reports/nec-tile-pairs.csv`;
- the existing `logic-prototype.html` extended with the first tile-metric layer only after the inventory passes.

### Demand-package milestone

- `generated/demand/tiles/<tile>/demand_data.json.gz` for local native demand;
- one packed cross-tile/external flow index;
- per-tile manifests with source versions, hashes, bounds, metrics, and capabilities;
- a report of points, cohorts, workers, compressed bytes, peak memory, and elapsed time per tile.

## 7. Milestones and stop conditions

### M0 — Selection lock

Parse and validate the export, generate the 34-tile catalog, calculate state intersections, and review the coverage map. Stop if any projected bounds or IDs differ from the export.

### M1 — Workplace-led inventory

Acquire 14 jurisdictions’ `main`, `aux`, and crosswalk files. Produce `workWorkers`, `externalInboundWorkers`, local/cross-tile pairs, WAC checks, and exact conservation results. Stop if any mass is unresolved without an explicit explanation.

### M2 — Complete resident-side inventory

Add all workplace-state `aux` files, filter to selected residence blocks, and produce `homeWorkers` and `externalOutboundWorkers`. Stop if the map labels the resident view complete without this stage.

### M3 — Demand map

Add the two metric layers to the OSM tile selector, preserve the simple interaction model, and export tile metrics beside the original tile selection.

### M4 — Runtime demand packages

Reuse the New York compiler’s 100 m site merge, 50–200 cohort packer, cross-tile ledger, and bounded active-tile loading. Gate this separately from the visual demand map.

## 8. Main risks and decisions to keep visible

- `EPSG:26918` is retained because the export and New York prototype depend on it. It is a regional prototype choice, not a final nationwide CRS decision.
- LODES internal points are block-level allocation points, not addresses or precise trip origins/destinations.
- LODES is suitable for relative demand structure and aggregate checks, not a direct observation of Northeast Corridor transit trips.
- 2023 is the selected first vintage. Every derived artifact must retain the LODES format, year, job type, source state, crosswalk vintage, and source hashes.
- Do not present the workplace-led M1 map as complete commuter demand until M2’s outside-workplace-state `aux` scan is complete.
- Do not generate 34 full native demand packages before M1/M2 totals, boundary assignment, and memory measurements pass.

## Source ledger

- Attached tile selection: `C:\Users\darkd\Downloads\nec-corridor-selection (5).json`.
- [LODES research notes](../prototype/nec-corridor/LODES-research-notes.md), based on official Census/LEHD sources.
- [LODES 8.4 technical documentation](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf).
- [LODES 8 distribution index](https://lehd.ces.census.gov/data/lodes/LODES8/).
- [LODES main/auxiliary code examples](https://lehd.ces.census.gov/data/lehd-code-samples/sections/lodes/basic_examples.html).
- [LODES data overview](https://lehd.ces.census.gov/data/).
- [New York State tiled-test plan](new-york-state-large-test-plan.md).
- [New York State research note](../research/new-york-state-large-test-research.md).
