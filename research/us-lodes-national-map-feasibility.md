# Nationwide U.S. map and LODES demand feasibility for Subway Builder

Research date: 2026-08-10  
Scope: a 50-state-plus-DC Subway Builder dataset, with emphasis on Census LEHD Origin-Destination Employment Statistics (LODES) commuter demand, the current community demand generator and Depot map pipeline, and the implications for a tiled open-world runtime. Puerto Rico is discussed separately because the current LODES release does not provide its OD files.

## Executive verdict

The national data is **feasible to acquire and preprocess on a normal development workstation**, but it is **not feasible to load into the current Subway Builder toolchain or renderer as one ordinary city**.

| Layer or representation | Defensible size | What that means |
| --- | ---: | --- |
| Required Census downloads: JT01 OD `main` + `aux` and block crosswalks | **903,121,037 B (861.3 MiB)** gzip | Easy to download and archive. |
| The same CSV inputs extracted | **11,750,020,483 B (10.94 GiB)** | Manageable offline; allow roughly **15–30 GiB** working space for conversions, temporary files, and indexes. |
| Sparse OD records before demand agglomeration | **about 126.7 million rows** | Too many Python/JavaScript objects for the existing eager generator/runtime. |
| Minimal packed raw OD lower bound | **1.52 GB** at 12 bytes/row; **2–6 GB** realistic | Good as an offline canonical/analytical layer, not as live object state. |
| Selected-column Parquet + Zstandard | **roughly 0.5–1.5 GB**, to benchmark | Recommended canonical intermediate, partitioned into 64–256 MiB row groups. |
| Existing compact JSON, extrapolated after Tampa-style agglomeration | **1.13 GB decimal (1.05 GiB) central; plan for 1–3 GB** | Still too large to parse into the renderer all at once. |
| Likely JavaScript heap for that national JSON | **roughly 3–8 GB** | Engineering allowance, not a measured V8 multiplier; millions of objects and garbage collection are the bigger risk. |
| Proposed per-tile binary runtime packages | **roughly 0.2–0.5 GB nationally** after comparable agglomeration, plus indexes | Plausible if only the active tile and a small prefetch ring are hydrated. |

The recommended design is therefore:

1. Keep the authoritative Census archive outside the game.
2. Stream-convert it into state/year-partitioned Parquet for reproducibility and offline queries.
3. Agglomerate and partition demand into compact binary tile packages.
4. Load at most about **250–500 MB of demand working state** for the active tile plus prefetch neighbors.
5. Represent inactive tiles with small aggregate origin/destination and network summaries, not native commuters.

The latest-year national choice is not a single vintage. Use **2023 for 49 jurisdictions, Michigan 2021, and Alaska 2016** if recency matters, and record the vintage per state. If temporal consistency matters more, use **2016 for all 50 states plus DC**, the latest common complete year.

## 1. What the official Census release contains

The current source is [LODES 8](https://lehd.ces.census.gov/data/lodes/LODES8/), format version 8.4. The [LODES 8.4 technical documentation](https://lehd.ces.census.gov/data/lodes/LODES8/LODESTechDoc8.4.pdf) says that:

- LODES is released as state-level gzip-compressed CSV in Origin-Destination (OD), Residence Area Characteristics (RAC), and Workplace Area Characteristics (WAC) groups.
- The available series spans 2002–2023 and uses 2020 Census blocks with 2024 TIGER/Line geography.
- Alaska and Michigan are absent from 2022–2023 OD/WAC data; Alaska is also absent from 2017–2021. All 51 state/DC partners are present in 2011–2016.
- Puerto Rico is not included in LODES because of incompatible data infrastructure.

The Census [December 18, 2025 announcement](https://lehd.ces.census.gov/php/inc_announcements.php) identifies 2023 as the latest release. Thus there are two defensible national assemblies:

| Assembly | States/DC | Strength | Limitation |
| --- | --- | --- | --- |
| Latest mosaic | 2023 for 49 jurisdictions; MI 2021; AK 2016 | Most recent available observation for each jurisdiction | Cross-state comparisons span three economic vintages. |
| Common vintage | 2016 for all 50 states + DC | Consistent national reference year | Materially older labor market. |

This report sizes the **latest mosaic**. Puerto Rico has a block crosswalk in the directory but no matching JT01 OD release, so it is excluded rather than silently fabricating commute flows.

### Why JT01 is the correct job type

The generator uses `JT01`, or **Primary Jobs**. The Census technical documentation defines job types, while Census research defines a worker's primary/dominant job as the beginning-of-quarter job with the greatest earnings. This produces one primary-job equivalent per worker and is a more defensible commuter count than `JT00` “All Jobs,” which can count a worker's multiple jobs. See the Census [primary-job methodology](https://www2.census.gov/library/working-papers/2025/adrm/ces/CES-WP-25-52.pdf).

### Minimum file inventory

For each of 50 states and DC, a Subway Builder demand build needs:

- one `*_od_main_JT01_YEAR.csv.gz` file: workplace and home are both in the workplace state;
- one `*_od_aux_JT01_YEAR.csv.gz` file: workplace is in the state and home is outside it;
- one state block crosswalk `*_xwalk.csv.gz`, providing Census block IDs and representative internal-point latitude/longitude.

That is **153 files**: 102 OD files and 51 crosswalks. Because each OD record is assigned to its workplace state, combining every state's `main` and `aux` files covers interstate commuters without duplicating jobs.

WAC files are not needed to construct individual OD flows, but are useful as a compact validation total. RAC can likewise validate residence totals. LODES is partially synthetic and represents workplace/residence relationships, not observed trip paths; the [OnTheMap data overview](https://lehd.ces.census.gov/doc/help/onthemap/OnTheMapDataOverview.pdf) explains the source and reference-period limitations.

## 2. Exact measured download and extracted sizes

The following totals were measured from the official [LODES8 state directories](https://lehd.ces.census.gov/data/lodes/LODES8/) on 2026-08-10. Compressed lengths are HTTP `Content-Length` values. Extracted lengths are the little-endian gzip `ISIZE` footer; every individual file is below the 4 GiB wrap boundary.

| Required input | Files | Compressed bytes | Extracted bytes |
| --- | ---: | ---: | ---: |
| JT01 OD `main` | 51 | 709,048,149 | 7,305,785,657 |
| JT01 OD `aux` | 51 | 51,597,789 | 421,247,754 |
| State block crosswalks, excluding PR | 51 | 142,475,099 | 4,022,987,072 |
| **Generator input total** | **153** | **903,121,037 (861.3 MiB)** | **11,750,020,483 (10.94 GiB)** |

Optional JT01 WAC summaries add **54,232,441 compressed bytes** and **308,688,908 extracted bytes**. Streaming their `S000` column gives **139,592,380 primary jobs** in **2,320,491 workplace-block rows** for the mixed-year assembly.

The Census directory also publishes checksums/version metadata; a production downloader should retain those plus URL, year, retrieval date, and hash in its build manifest.

### OD row count

Three large/small state samples have remarkably stable extracted line lengths:

| JT01 `main` sample | Data rows | Extracted bytes per row, including proportional header/newline |
| --- | ---: | ---: |
| Wyoming 2023 | 198,543 | 61.003 B |
| New York 2023 | 7,055,595 | 61.001 B |
| California 2023 | 14,634,271 | 61.001 B |

Dividing the exact combined extracted OD size by 61.001 bytes/row gives:

`(7,305,785,657 + 421,247,754) / 61.001 ≈ 126,670,600`

So the national sparse input contains **about 126.7 million nonzero home-block/work-block pairs**. The estimate is close enough for capacity planning; an exact nationwide row count would require streaming all 102 files. The official [Census block tally](https://www.census.gov/geographies/reference-files/2020/geo/tallies.html) gives 8,132,968 possible 2020 blocks in the 50 states plus DC, although only a subset carries workplace or residence demand.

## 3. Processed demand size scenarios

These layers should not be conflated. The archive size is not the extracted staging size, and neither predicts JavaScript heap directly.

### A. Raw sparse OD, compact columns

At an absolute conceptual minimum, a row can be represented as three unsigned 32-bit values—home index, work index, and worker count—after block IDs are dictionary-encoded:

`126.67M rows × 12 B = 1.52 GB decimal`

That omits partition metadata, dictionaries, indexes, checksums, alignment, and any travel fields. A realistic packed raw layer is **2–6 GB**. Selected-column Parquet with Zstandard compression is likely **0.5–1.5 GB**, but that is a forecast that must be benchmarked on several dense and sparse states before committing the format.

If each raw row were expanded directly into the current demand JSON object shape, a conservative roughly 160 bytes/flow implies about **20 GB of compact JSON**, before parsing. This option is not viable.

### B. Existing Tampa fixture extrapolation

The current Depot fixture [TPA_LODES_demand_data.json](https://github.com/Subway-Builder-Modded/depot/blob/ef4ab40dce4b3787e4c994f6c426ddd637d30f05/examples/demand/TPA_LODES_demand_data.json) was measured locally:

| Fixture property | Measured value |
| --- | ---: |
| Compact JSON bytes | 10,166,787 |
| Demand points | 3,339 |
| Final pops | 58,551 |
| Represented workers (`sum(pop.size)`) | 1,259,325 |
| Workers per final pop | 21.508 |
| JSON bytes per final pop | 173.640 |

Scaling those two ratios by the WAC national total yields:

- `139,592,380 / 21.508 ≈ 6.49 million final pops`;
- `6.49M × 173.640 B ≈ 1.127 billion B`, or **1.05 GiB compact JSON**;
- the Tampa point/pop ratio suggests about **370,000 points**.

This is the best central estimate grounded in an actual Subway Builder file, but it is not a guarantee. National rural/urban composition, cross-tile boundary handling, agglomeration thresholds, and maximum pop size can change both ratios. Budget **1–3 GB of compact JSON** if retaining the current schema.

The community [U.S. demand generator](https://github.com/rslurry/subwaybuilder-US-demand-data/blob/fe5e29ebf5b94a29478d233881393c36bdef2586/create_US_demand_file.py#L706-L841) downloads/decompresses state crosswalk and JT01 OD files and eagerly loads them into NumPy arrays. It then constructs every point and pop as Python dictionaries, agglomerates small flows, calculates driving metrics, enforces a maximum pop size, and emits one JSON object. Its [README](https://github.com/rslurry/subwaybuilder-US-demand-data/blob/fe5e29ebf5b94a29478d233881393c36bdef2586/README.md#L1-L4) explicitly says agglomeration is needed to make point/pop counts feasible. This is a metro-batch generator, not a national streaming pipeline.

The Tampa fixture omits `drivingPath`; that is important. Nationwide path polylines would overwhelm the demand payload. Store only coarse driving seconds/distance where needed, and calculate detailed paths only for the active region.

### C. Proposed runtime binary

After Tampa-like agglomeration, a purpose-built runtime can store roughly 6.49 million flows at 20–32 bytes each and about 370,000 points at 24–32 bytes each:

- flows: about **130–208 MB**;
- points: about **9–12 MB**;
- indexes, tile tables, boundary records, checksums, and alignment: plan for a national total of **about 0.2–0.5 GB**.

This is a design estimate, not an existing output. A practical tile package could contain:

- `nodes.bin`: local coordinate, jobs/residents, and stable world ID;
- `trips.bin`: compressed-sparse-row home-to-work flows;
- `gates.bin`: cross-tile flow endpoints and aggregate transit interfaces;
- `inactive.bin`: hourly aggregate state/sufficient statistics;
- `manifest.json`: schema, projection, source state/year/hash, bounds, and dependencies.

Keep mutable player/network state in a small transactional SQLite database rather than rewriting immutable data tiles.

## 4. Runtime memory and tile budgets

A 1–3 GB JSON file does not occupy 1–3 GB after parsing. Strings, object headers, arrays, hash tables, indexes, duplicated state, and temporary parse buffers all add overhead. Without a representative national V8 heap benchmark, **3–8 GB** is a reasonable engineering allowance, not a hard measurement. More importantly, six million pop objects create severe garbage-collection and traversal costs even if the process has enough address space.

Useful active-region reference points, using the measured 173.64 compact bytes/pop and a broad 2.5–6× heap allowance, are:

| Active final pops | Compact JSON equivalent | Approximate heap allowance |
| ---: | ---: | ---: |
| 60,000 | 10 MB | 25–60 MB |
| 250,000 | 44 MB | 100–250 MB |
| 750,000 | 130 MB | 300–750 MB |

The official Subway Builder [Performance & Memory guide](https://www.subwaybuilder.com/docs/guides/performance) warns that large maps can exhaust renderer memory and trigger tile failures and garbage-collection thrashing. A sensible first target is therefore **no more than 250–500 MB total active-plus-prefetch LODES state**, with adaptive tile subdivision in dense metros.

Inactive simulation can be tiny by comparison. For example, 10,000 coarse tiles with a 1 KiB state record and 32 outbound edges of 12 bytes each require only about **13.5 MB** before ordinary container overhead. That is the correct place to preserve national connectivity while advancing inactive regions hourly or daily.

## 5. The other national map layers are at least as important

LODES is not the only scaling problem. Subway Builder configures demand, roads, and building collision data as city-level assets, whereas visual basemap tiles can already be fetched spatially.

At Depot commit `ef4ab40d`, [`run_all`](https://github.com/Subway-Builder-Modded/depot/blob/ef4ab40dce4b3787e4c994f6c426ddd637d30f05/src/depot/maps.py#L331-L339) is a batch pipeline. Its [SBBI collision-index generation](https://github.com/Subway-Builder-Modded/depot/blob/ef4ab40dce4b3787e4c994f6c426ddd637d30f05/src/depot/maps.py#L532-L833) builds whole buffers, and its [tile-reading stage](https://github.com/Subway-Builder-Modded/depot/blob/ef4ab40dce4b3787e4c994f6c426ddd637d30f05/src/depot/maps.py#L2328-L2384) materializes all selected tiles. The [Depot README](https://github.com/Subway-Builder-Modded/depot/blob/ef4ab40dce4b3787e4c994f6c426ddd637d30f05/README.md#L152-L167) also says that it currently edits an existing demand file and treats U.S. generator integration as future work.

The installed New York City collision index contains 1,368,300 buildings and measures **219.61 MiB raw / 71.40 MiB gzip**. Linear feature-count extrapolation to the more than 75 million U.S. structures described by the [Overture Maps/FEMA integration](https://overturemaps.org/blog/2023/enriching-overture-maps-data-with-gers/) is roughly **12.0 GiB raw / 3.9 GiB gzip**. This is only a scale indicator—geometry complexity and spatial distribution differ—but it rules out treating nationwide collision data as one eager file.

A contiguous-U.S. bounding box also includes enormous ocean and empty areas. At zoom 15 it spans roughly **15.7 million tiles**; a dense ocean-depth/interpolation grid can exceed **80 GiB** in major arrays. One bounding box, one UTM zone chosen from its center, and one `MapGen` pass are structurally poor choices for Alaska, Hawaii, the contiguous states, and other noncontiguous geography.

PMTiles/range-served vector tiles are appropriate for immutable visual layers. They do not solve eager demand, roads, building collision, or mutable simulation state unless those layers are partitioned too.

## 6. Recommended national build and runtime architecture

### Offline build

1. **Acquire reproducibly.** Download state gzip files, retain them compressed, and record SHA-256, byte length, Census URL, state, job type, and vintage.
2. **Stream, do not concatenate.** Decode OD rows in chunks; dictionary-map block IDs from the crosswalk without creating 126.7 million Python dictionaries.
3. **Write a canonical analytical layer.** Use Parquet/Zstandard partitioned by workplace state/year and a stable spatial tile key, with 64–256 MiB row groups. Query it offline with DuckDB or equivalent.
4. **Agglomerate spatially with invariants.** Preserve total worker counts and home/work tile totals. Keep a reproducible configuration and regression-test several city fixtures.
5. **Partition every nonvisual layer.** Demand, roads, building collision, routing nodes, and optional terrain/ocean data need the same world tile scheme. Use region-specific projections; never project the whole country through one UTM zone.
6. **Generate boundary summaries.** Split inter-tile flows into local detailed legs plus stable gateway/portal records. Validate that local and boundary totals reconstruct state/national WAC/RAC totals within documented rules.

### Runtime

1. **Hydrate one detailed active tile.** Convert that tile's packed records to the game's documented demand representation only at the integration boundary.
2. **Prefetch a small neighbor ring.** Enforce a memory budget, not a fixed geographic radius; dense metros require smaller tiles.
3. **Advance inactive tiles coarsely.** Store aggregate population, jobs, service supply, ridership, cash-flow effects, and flows between gateways. Update hourly/day-level, not commuter-by-commuter.
4. **Reconcile on transition.** At a tile boundary, settle aggregate arrivals/departures, snapshot active native state, then hydrate the destination. Cross-tile trains/passengers become scheduled gateway events; they cannot remain ordinary native entities while unloaded.
5. **Keep the basemap independent.** Let MapLibre/PMTiles range-load visuals while simulation packages use their own versioned tile store.

This complements the wider open-world feasibility finding: the current game exposes enough hooks to prototype active-tile snapshot swapping and mod-owned inactive simulation, but it has one global live state rather than a hidden multi-world engine. The national dataset is therefore a preprocessing and level-of-detail project, not simply a larger city JSON.

## 7. Decision and proof-of-concept plan

Proceed, but gate the national build behind a two-stage benchmark:

### Stage 1: three representative regions

Build dense urban (NYC), sprawling metro (Tampa or Dallas), and rural/mountain tiles. Measure:

- raw rows to final pops and points;
- Parquet compression;
- binary tile bytes per worker/pop;
- generator peak RAM and elapsed time;
- JSON conversion and V8 parse/heap cost;
- active simulation frame time and transition latency.

Pass criteria should include conservation of job totals, active-plus-prefetch demand below 500 MB, and no large renderer garbage-collection pauses.

### Stage 2: one multistate corridor

Build a corridor crossing state and tile boundaries so `main`/`aux`, mixed vintages, gateways, and off-tile simulation are exercised. Only after this passes should the pipeline process all 51 jurisdictions.

## Bottom line

- **Storage:** yes. The authoritative national JT01 demand input is under 1 GiB compressed and about 11 GiB extracted.
- **Offline processing:** yes, after replacing eager whole-file object construction with a streaming, partitioned pipeline.
- **One nationwide current-format city:** no. Expect around 6.49 million final pops and 1–3 GB compact JSON, with several gigabytes of renderer heap and unacceptable object/GC pressure.
- **Tiled open world:** credible. A 0.2–0.5 GB national binary demand product, small inactive summaries, and a 250–500 MB active working-set cap are defensible initial targets.
- **Full national map:** feasible only if roads, buildings/collision, routing, terrain, and simulation state are tiled alongside demand. Visual map tiling alone is insufficient.

## Reproducibility notes and limitations

- Exact LODES byte totals are point-in-time measurements of Census-hosted files on 2026-08-10; corrections can change individual archives.
- Gzip `ISIZE` gives exact extracted bytes here because each individual file is below 4 GiB. It does not validate contents; production builds should also verify the Census hashes.
- The 126.7 million row figure is inferred from exact extracted bytes and three measured row-length samples, not an exhaustive newline count.
- The 1.13 GB JSON estimate assumes Tampa's 21.508 workers/pop and 173.640 bytes/pop ratios. The 1–3 GB range acknowledges national clustering uncertainty.
- Packed-binary, Parquet, and heap figures are engineering forecasts that require the proposed benchmarks.
- LODES is partially synthetic and block coordinates are internal points, not building addresses, trip routes, or necessarily geometric centroids.
- A mixed-year national mosaic must never be presented as a single 2023 snapshot. Persist each jurisdiction's vintage through the entire pipeline and UI.
