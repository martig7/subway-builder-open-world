# Japan boundary-first demand

## Ownership and placement

`worlds/japan/world.json` declares `tileViews.ownershipBoundary` as the full
approved playable outlines. These are distinct from raw administrative/physical
geometry (`map.computationBoundary`) and zoom-dependent display LODs
(`tileViews.boundaryOverlay`). Display detail never determines demand membership.

The detailed-boundary builder now defaults to retaining small islands (zero
minimum island area) while continuing to fill inland-water holes. Display LODs
alone omit detached components below their squared metre tolerance. The largest
component of each prefecture and components sharing a border with another
prefecture are always retained; zoom 13's zero-tolerance level keeps all parts.
Interior rings occupied by another prefecture are legitimate administrative
enclaves, not water holes: filling them would introduce overlapping ownership.

Source extraction and final placement share `resolve_cell_ownership`: a cell's
centre chooses its owner; a coastal cell whose centre misses the polygons uses
its greatest footprint overlap. Ties are deterministic. Statistical source
prefecture labels remain OD provenance, not building-index selectors.

`compile_boundary_sites` assigns ownership before snapping slight coastal
overhangs inside the owner and before building placement. All evidence assigned
to an owner enters one building-selection and 350 m clustering pass. Final
anchors must be actual indexed building centres covered by that owner, including
after coordinate rounding. Source home/job marginals are conserved separately.

`OwnedDemandLedger` classifies commutes once from their final endpoint owners.
Same-owner trips are native; different-owner trips are cross-tile. Runtime ID
prefixes follow that final classification. There is no deferred census-cell
placement path or permanent cross-tile flag attached to repaired points.

The World currently sets a conservative 750 m boundary-snap limit and 5 km
cell-to-building-site assignment limit. Unplaceable evidence fails compilation;
it is neither discarded nor emitted as a grid fallback. A new output directory
must be used for evaluation. Successful compilation writes preliminary geometric
times, **not a routed release**. OSRM/ferry/water enrichment and independent
verification must finish before replacing installed data. Existing coordinate-
keyed routing caches can be reused; changed endpoints need fresh route values.

## Regression evidence — 2026-09-05

The previous deferred path kept one site per census cell. Snapping each to a
nearby building preserved the grid and sometimes retained cross-tile status even
after both endpoints landed inside the same owner. The normal interior path used
irregular building clustering, so edge areas looked different.

The executable pilot is `map-creator/scripts/audit_japan_edge_placement.py`:

```powershell
$env:PYTHONPATH='map-creator/src'
& 'C:/Program Files/Python312/python.exe' map-creator/scripts/audit_japan_edge_placement.py
```

It reads local evidence/building artifacts, compares the current generated
Osaka package with boundary-first placement, and writes diagnostics only under
`.analysis/japan-routing`. Its geometric measure does not depend on point IDs.

| Sample | Previous points near mesh centres | Boundary-first pilot |
| --- | ---: | ---: |
| Ikeda | 151 / 178 (84.83%) | 6 / 64 (9.38%) |
| Shimamoto | 14 / 44 (31.82%) | 3 / 34 (8.82%) |

All pilot source marginals were conserved, all anchors were inside their owners,
and there were zero unanchored sites. This is an artifact-level result, not a new
in-game visual confirmation. The pilot test uses the previous package as its
baseline; after publication, its strict improvement assertion is no longer a
meaningful comparison without preserving that baseline.

## Original publication blocker: excluded land

The nationwide audit covered 795,442 positive home cells and 317,949 positive
job cells. Of these, 2,963 home and 3,697 job centres are outside the approved
outlines. Forty-five cells across eleven prefectures are more than 750 m from
the nearest outline; the maximum is 2,540 m. They carry 463 home-marginal units
and 563 job-marginal units (not additive unique commuters).

Comparison with raw administrative geometry places 44 of the 45 cells on or near
land components smaller than 1 km² removed from the playable outlines. The other
is a four-job Hyogo cell at 135.278125, 34.65625, approximately 1,395 m outside
both approved and raw geometry; its source needs separate review.

The user subsequently chose to restore small islands to detailed ownership
instead of moving their demand to the mainland. Do not increase the snap limit
silently. Existing installed demand and completed routing remain untouched until
a new package passes placement, routing, and publication checks.
Detailed local audit results are in
`.analysis/japan-routing/excluded-land-audit.json`; the failed compilation log is
`.analysis/japan-routing/boundary-first-progress.jsonl`.

## Recheck after island restoration — 2026-09-05

Rebuilt all 47 detailed boundaries and the Tile View catalog from the locked
raw e-Stat geometry with `--minimum-island-area-km2 0`, then regenerated display
LODs. All 44 previously flagged island cases are now within the 750 m ownership
placement limit. The nationwide audit of 1,113,391 positive source cells leaves
one exception: the four-job Hyogo cell described above, still 1,394.9 m offshore.
No source cells were deleted, and no placement distance limits were increased.

The shared-edge, overlap, validity, and unowned-water-hole regression checks pass.
The two new interior rings are wholly occupied by neighboring prefectures
(Ibaraki inside Tochigi, and Tokyo inside Kanagawa); they must not be filled.
The Osaka placement pilot retains its previous improvement and conservation
results. At zoom 0 the display uses 41,725 vertices; at zoom 13 it uses 932,560.
The detailed display retains all parts, while the coarsest copy hides 3,630
sub-resolution detached components.

A separate check of building indexes on the restored island components found
eight source cells without an indexed island building: one home cell in Mie
(13 home-marginal units), and seven cells in Nagasaki (94 home-marginal units,
80 job-marginal units). This is a building-input coverage issue, not a reason to
snap the demand to the mainland. The isolated-island placement pilot also flags
Mie and Nagasaki; its distances are diagnostic for that limited sample, not
predicted distances for a full national package.

Reproduce the nationwide source audit from the repository root:

```powershell
$env:PYTHONPATH='map-creator/src'
python map-creator/scripts/audit_japan_source_ownership.py `
  --output .analysis/japan-routing/source-ownership-recheck.json
```

It currently exits 1 to report the unresolved Hyogo cell. Detailed recheck
artifacts are under `.analysis/japan-routing/islands-20260905/`, including
`source-ownership-audit.json`, `restored-island-audit.json`, and
`island-building-coverage.json`. The updated World geometry is committed source
data only: no new national demand package, routing run, or mod installation was
performed during this recheck.

## Input repair and physical-land gate — 2026-09-05

The nine remaining input exceptions were reproduced together, then checked
against the cached OSM extracts and the physical-land mask. The Hyogo jobs cell
is about 5.3 m from mapped physical land, not 1.4 km from land: the latter was
distance to the incomplete administrative ownership outline. The reviewed
component is recorded in `worlds/japan/geography/ownership-additions.geojson`.
It changes only Hyogo, introduces no overlap with other owners, and follows the
existing ownership policy of filling water holes. The physical-land mask keeps
those holes. Rebuilding the catalog must include:

```text
--ownership-additions worlds/japan/geography/ownership-additions.geojson
```

The cached OSM extracts have no building ways in the affected Mie and Nagasaki
island areas. Supplemental footprints come from GSI's public optimal vector
tiles, layer `BldA`, zoom 16, downloaded using small PMTiles byte ranges rather
than the national archive. The World stores the selected footprints and anchors,
source URL, attribution, tile coordinates and tile hashes. Source:
<https://github.com/gsi-cyberjapan/optimal_bvmap> (国土地理院最適化ベクトルタイル).
One Hyogo anchor instead uses the land-covered portion of cached OSM building
way 921932304; its bounding-box centre is over water. No artificial building was
invented. The original nine-cell placement reproduction now passes.

`supplementalBuildingAnchors` is a declarative demand input. It augments the
building candidates before the existing shared clustering pass, not afterwards.
Source weights and the 750 m boundary / 5 km assignment limits remain unchanged.
The dense candidate pool still uses a 750 m neighborhood. In sparse areas it
also includes each source cell's nearest eligible real building within the
existing 5 km assignment cap. Previously the narrow prefilter could discard a
valid building 1–3 km away, then assign to a distant site or fail. These additional
candidates enter the same clustering pass; the final 5 km guard still runs after
clustering. Three isolated one-job Hokkaido cells reproduce this distinction.

Compiler `estat-japan-national-package-v7-land-anchored` also requires Japan's
hash-pinned `physicalLandMask`. Both generation and independent verification
check actual serialized points against physical land, independently of the
water-filled ownership/display outlines. This prevents an in-boundary building
centre over a river or harbour from passing the placement gate. The mask lives
in the central source store at `japan/geography/physical-land-repaired.geojson`;
its SHA-256 is recorded in `worlds/japan/demand.json`. Large source data stays
outside Git. Existing installed demand is not upgraded by these source edits.

The first national retry exposed an additional Hokkaido assignment exceeding
9 km. A full source-to-building coverage audit is therefore required before
publication; the original nine-cell success is not national validation.

The completed baseline building-coverage audit found 4,028 positive source cells
above the 5 km cap, across 41 owners (5,923 above a 4.5 km preflight margin).
This includes missing rural building coverage and Tokyo's distant islands absent
from the old mainland building index. It does not mean those cells' coordinates
are wrong. Supplement retrieval and merge are centralized scripts:

```powershell
# Optional dependencies: pip install -e 'map-creator[building-supplements]'
python map-creator/scripts/fetch_japan_building_supplement.py `
  --cases .analysis/japan-routing/national-building-gaps.json `
  --output .analysis/japan-routing/gsi-national-gaps.geojson `
  --cache .analysis/japan-routing/gsi-range-cache
python map-creator/scripts/merge_japan_building_supplement.py `
  --source .analysis/japan-routing/gsi-national-gaps.geojson
```

The lookup requests public archive byte ranges, not demand uploads. Individual
responses and tile hashes are retained for resumption/provenance. The merger
accepts only real building-footprint points covered by both owner and physical
land. It records imports without changing source weights. A full topology
validation of the physical mask completed locally; its reusable validity stamp
is keyed by source bytes and GEOS version. Point membership is never cached away.

The supplemental input now contains 174,750 verified anchors across 41 owners.
The national lookup added 172,913 anchors; targeted island, Hokkaido and Kumamoto
lookups supply the remainder. The final Kumamoto exception represented eight
jobs, initially 5,989 m from an eligible site. A wider public-footprint lookup
added 15 valid owned, on-land anchors; the owner now passes the unchanged 5 km
limit. Prefectures 44–47 had no remaining cells beyond the 4.5 km preflight
margin. Footprints outside physical land or the requested owner are rejected,
even when geographically close to the source cell.

Supplement imports replace complete files atomically, publishing footprints
before anchors. Replaying a failed import restores missing footprint provenance
without duplicating anchors. This addresses a Windows file-write failure seen
during the final targeted import.

## Completed national regeneration — 2026-09-05

The final v7 run completed all 47 prefectures in 371 seconds. Its independent
verification passed against the serialized outputs:

| Check | Result |
| --- | ---: |
| In-tile point records | 246,431 |
| Cross-tile point records | 31,420 |
| In-tile / cross-tile cohorts | 602,807 / 33,553 |
| Accepted / generated demand mass | 69,466,356 / 69,466,356 |
| Points outside assigned ownership | 0 |
| Points outside physical land | 0 |
| Unanchored sites | 0 |
| Maximum home / jobs cell-to-site distance | 4,479.214 m / 4,579.736 m |
| Maximum coastal ownership adjustment | 337.693 m |

Point counts are per dataset, not a distinct-location union: one location can
participate in both native and cross-tile demand. The legacy verifier fields
named `outsideRenderedBoundary` check full ownership geometry, not simplified
display LODs. No placement cap was relaxed and no source demand was discarded.

The staged package is `.analysis/japan-routing/demand-v7-land-anchored`; its
`reports/verification.json` and `reports/japan-national-demand.json` record the
audit and source hashes. Progress is retained in
`.analysis/japan-routing/demand-v7-progress.jsonl`; earlier failed attempts also
appear in that append-only log. The completed package uses preliminary geometric
travel times and is **not an OSRM-routed release**. Existing routed demand under
`prototype/japan/generated/demand`, the installed `local.japan-open-world` mod,
and tile services were not replaced or restarted. The runnable consumer remains
`prototype/japan/mod`; routing and installation are separate next steps.

Recheck the staged output:

```powershell
$env:PYTHONPATH='map-creator/src'
python -m open_world_map_creator.demand.verify_japan `
  --world-root worlds/japan `
  --demand-root .analysis/japan-routing/demand-v7-land-anchored
```

Validation during this change: map-creator 72 passing tests and one skipped;
shared platform 486 passing; Japan consumer two passing. The on-disk package
audit is not an in-game visual confirmation.

## Completed v7 reroute — 2026-09-05

The regenerated package was rerouted with the existing OSRM MLD dataset
`geofabrik-japan-8b9165a595130fbe-car-v6`, passenger ferries with a 300-second
exit transfer, and the existing 5 km/h straight-water fallback. The runner used
the same hash-verified physical-land source as demand generation, 16 OSRM
workers, and the durable coordinate-keyed cache. No road graph rebuild or cache
deletion was needed. Processing finished in 1,120.32 seconds (18m 40s).

All 602,807 native and 33,553 cross-tile cohorts were processed. Cross routing
retains the existing four-samples-per-directed-pair model (2,023 groups), with
endpoint-specific ferry/water checks; this is not a new exact-road query for
every cross-tile cohort. Final route classifications across both datasets:

| Classification | Cohorts |
| --- | ---: |
| OSRM | 600,192 |
| OSRM-derived cross-tile model | 33,543 |
| Passenger ferry | 758 |
| Synthetic straight-water | 401 |
| Unresolved-route estimate | 1,462 |
| Geometric cross-pair estimate | 4 |

The 1,466 remaining estimate-backed cohorts are about 0.23% of 636,360 cohorts,
not a population-weighted percentage. Final water attempts reported 1,291
`no-reachable-land-road` failures and one `same-landmass` failure; attempt counts
are not cohort counts. These unresolved connections were retained explicitly,
not claimed as successful routes or removed from demand. The cache recorded
4,245,099 hits and 2,453,914 misses, including ferry-access intermediate queries.

The downloaded result archive was verified against SHA-256
`8a56a6a4805c29143683db37bcb6afe93ffc5e0b0a8140e894096830616c16e9`.
A before/after comparison proved identical point records and identical cohort
fields other than driving time/distance. The independent national verifier
again confirmed all 69,466,356 demand units, zero off-land points, and zero points
outside their assigned ownership. Routing metrics changed for 597,074 native
cohorts and all 33,553 cross cohorts; unchanged metrics are permitted coincidences
or minimum-time results, not skipped input cohorts.

The verified 195-file package is now the active generated demand at
`prototype/japan/generated/demand`. The previous package was preserved at
`.analysis/japan-routing/reroute-v7-20260905/previous-demand`; the rerouted download,
audit script, input archive and progress logs remain under the same run folder.
Reports include `reports/reroute-verification.json` and
`reports/japan-national-road-routing.json`. For routing completion consult
`roadRouting.completed` and the routing report; the compiler's older
`routingStatus` string describes the initial seed stage.

The selected consumer is still `prototype/japan/mod`, manifest
`local.japan-open-world`. No build, install or tile-service restart was performed;
the next consumer build will read this new routed package. Routing-related tests
passed (8 routing, 5 ferry plus one skipped, 12 water). Work is recorded on
`codex/japan-demand-v7-reroute`.
