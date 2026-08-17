# LODES planning memo for the Northeast Corridor demand map

Research date: 2026-08-16  
Scope: official U.S. Census/LEHD LODES documentation and distribution pages only. This memo plans aggregation from the NEC prototype's exported EPSG:26918 tile selection; it does not implement a pipeline.

## Findings

### What to download

Use one LODES 8.4 release. The official [LODES distribution index](https://lehd.ces.census.gov/data/lodes/LODES8/) provides state directories, and each directory contains `od/`, `rac/`, `wac/`, a state geography crosswalk, `version.txt`, and a SHA-256 checksum file. The relevant [NEC state directories](https://lehd.ces.census.gov/data/lodes/LODES8/ma/), [RI](https://lehd.ces.census.gov/data/lodes/LODES8/ri/), [CT](https://lehd.ces.census.gov/data/lodes/LODES8/ct/), [NY](https://lehd.ces.census.gov/data/lodes/LODES8/ny/), [NJ](https://lehd.ces.census.gov/data/lodes/LODES8/nj/), [PA](https://lehd.ces.census.gov/data/lodes/LODES8/pa/), [DE](https://lehd.ces.census.gov/data/lodes/LODES8/de/), [MD](https://lehd.ces.census.gov/data/lodes/LODES8/md/), [DC](https://lehd.ces.census.gov/data/lodes/LODES8/dc/), and [VA](https://lehd.ces.census.gov/data/lodes/LODES8/va/) expose that layout. The download page explicitly recommends not combining separate releases; retain each state's `version.txt`, file URL, retrieval date, and checksum with the build manifest ([Census LODES download page](https://lehd.ces.census.gov/php/inc_lodesDownloadTool.php); [LODES 8.4 technical document](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).

For a standard worker-demand map, start with `JT01` (Primary Jobs) and the `S000` total column. The OD file itself contains `w_geocode`, `h_geocode`, `S000`, age/earnings/industry segments, and `createdate`; `JT00` is All Jobs, while `JT01` is Primary Jobs. Choose `JT00` only if intentionally modeling multiple jobs per worker ([LODES 8.4 technical document, OD structure](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).

For the Boston–Washington footprint, the core state/equivalent set is MA, RI, CT, NY, NJ, PA, DE, MD, DC, and VA. All are covered by the 2023 LODES 8.4 availability table; the 2022–2023 exceptions are Alaska and Michigan. LODES 8.4 covers most states for 2002–2023, but availability varies by state-year. The 2011–2016 window is the only period shown as complete for all 51 state/DC partners; NEC-only work can use 2023, provided the selected release is treated as one vintage ([LODES 8.4 technical document, coverage table](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).

### Auxiliary versus in-state demand

OD filenames are `[st]_od_[main|aux]_[JTxx]_[year].csv.gz`. Census defines the parts as:

- `main`: workplace and residence are both in the file's state;
- `aux`: workplace is in the file's state and residence is outside that state.

The file's state is therefore the workplace-side partition, not a complete residence-state file. The official code sample makes the consequence explicit: to find residents of one state who work anywhere, collect that state's `main` file plus the `aux` files from every other state ([LODES 8.4 technical document](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf); [Census LODES code sample on main/auxiliary OD files](https://lehd.ces.census.gov/data/lehd-code-samples/sections/lodes/basic_examples.html)).

For the exported NEC tiles:

1. If the map is workplace-led—jobs whose workplace falls in selected tiles—scan `main` and `aux` OD files for each workplace state touched by the selection. `aux` is required for commuters arriving from outside the workplace state.
2. If it is residence-led—residents in selected tiles working anywhere—scan the selected residence states' `main` files and `aux` files from every possible workplace state. A corridor-only scan will miss residents whose jobs are outside the corridor.
3. If it is a complete selected-subgraph map, retain both endpoints and classify every retained row as local, selected-to-external, external-to-selected, or external-to-external. Do not count `main` and `aux` as two independent demand populations; they are complementary partitions of OD records by workplace state.

### OD, WAC, and RAC roles

OD is the authoritative source for a pairwise home-to-work flow because each row carries both a workplace block and a residence block. WAC is a workplace-block marginal: use it for workplace heatmaps and a conservation check on selected workplace totals. RAC is a residence-block marginal: use it for residence heatmaps and a check on selected residence totals. Neither WAC nor RAC preserves the home/work pairing ([Census LODES code samples](https://lehd.ces.census.gov/data/lehd-code-samples/sections/lodes/basic_examples.html); [LODES 8.4 technical document](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).

Keep geographic IDs as strings. The Census examples do this to preserve exact 15-character block IDs when merging. Use the `S000` total unless the prototype intentionally exposes age, earnings, or industry filters. Sum OD rows only after both endpoints have been assigned to the desired aggregate geography.

### Geography and crosswalk requirements

LODES 8.4 is enumerated on 2020 Census tabulation blocks and uses 2024 TIGER/Line geography. The state crosswalk's stable join key is `tabblk2020`, which links to OD/RAC/WAC `h_geocode` and `w_geocode`. Its `blklatdd` and `blklondd` fields are decimal-degree coordinates for an internal point of each block. Census warns that this point is not a centroid; the only guarantee is that it lies inside the block ([LODES 8.4 technical document, geography crosswalk](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).

For tile aggregation, join each endpoint geocode to the relevant state crosswalk, transform the internal-point longitude/latitude to EPSG:26918, then assign it to the exported tile's half-open ownership bounds. Treat the assignment as a block-point allocation, not as exact block-area overlap. This is suitable for a demand prototype, but blocks near a tile edge can move when the representative internal point or tile boundary changes. Keep a boundary/halo policy separate from the ownership assignment so the 2 km halo does not double-count demand.

`aux` rows require a crosswalk lookup for the out-of-state residence endpoint. Inference for the pipeline: route each `h_geocode` to the crosswalk whose state FIPS is encoded in that 15-character block GEOID, while `w_geocode` uses the workplace state's crosswalk; assert that both joins resolve. This follows Census's definition that `aux` residences are in another state and its requirement that OD aggregation can require separate residence and workplace crosswalk joins ([Census LODES code sample](https://lehd.ces.census.gov/data/lehd-code-samples/sections/lodes/basic_examples.html)).

The crosswalk also supplies current higher-level geography codes. Census cautions that those boundaries are current for all LODES years, so a 2018 and a 2023 aggregation made through the same current crosswalk are not necessarily historical-boundary comparisons. For EPSG:26918 tiles, use the endpoint coordinates and the prototype tile contract rather than treating county/place fields as tile geometry.

### Caveats for interpretation

- LODES is a tabulated and modeled administrative-data product subject to nonsampling errors; Census says there is no probability sample and therefore no sampling error measure. It is appropriate for relative demand structure and aggregate conservation checks, not as a precise count of observed trips ([Census LEHD data page](https://lehd.ces.census.gov/data/)).
- OD expresses home/work block relationships. It does not provide a transit mode, station choice, departure time, or route geometry; using it as “Northeast Corridor transit demand” is an additional modeling assumption.
- The release uses disclosure-avoidance practices approved by the Census Bureau. Treat very small block-level values as limited-detail public-use estimates rather than precise observed counts, and check results at sufficiently large tile or corridor totals ([LODES 8.4 technical document](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf)).
- Do not mix LODES versions or block vintages casually. LODES 8 uses 2020 blocks; earlier LODES versions use 2010 or 2000 blocks. Persist format version, state data vintage, year, job type, and crosswalk vintage in every derived tile manifest ([Census LODES data page](https://lehd.ces.census.gov/data/)).

## Recommended prototype contract

Use `JT01`, `S000`, LODES 8.4, and the 2023 year for the ten NEC state/DC jurisdictions. Build endpoint lookup tables keyed by 15-character `tabblk2020`/geocode, with WGS84 internal-point coordinates and transformed EPSG:26918 coordinates. Aggregate OD by `(home_tile_id, work_tile_id)` while retaining `source_workplace_state`, `main|aux`, and the source year/vintage. Validate that selected-tile OD marginals reconcile to the corresponding WAC workplace totals and RAC residence totals under the same endpoint-point assignment. Model external endpoints as explicit boundary flows rather than dropping them.
