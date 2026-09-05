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
