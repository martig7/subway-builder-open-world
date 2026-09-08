# Building ownership filtering

Tokyo and Kanagawa now load buildings only where their assigned prefecture
intersects the building footprint. Filtering happens offline, before the game
loads either the native building index or the rendered building tiles. No runtime
polygon checks, additional rendering cache, or forced garbage collection is used.

The first rollout covers `JP_TOKYO_MAINLAND` and `JP_KANAGAWA_MAINLAND`. The Japan
artifact pipeline applies the same stage to subsequently generated packages.
Roads, water, labels, demand and routing remain unchanged. This changes building
coverage; it does not clip every basemap layer to a prefecture.

## Measured package savings

Built on richmpc on 2026-09-08, using the full computation boundaries from the
central e-Stat prefecture source, not the simplified display polygons. MB below
means 1,000,000 bytes. Exact counts, hashes and live samples are in
[`building-ownership-results.json`](building-ownership-results.json).

| Metric | Tokyo before → after | Kanagawa before → after |
| --- | --- | --- |
| Native buildings | 3,448,574 → 1,263,776 | 2,594,570 → 1,419,050 |
| Decoded native index | 487.98 → 179.60 MB (−63.2%) | 367.01 → 200.02 MB (−45.5%) |
| Compressed native index | 163.82 → 59.84 MB | 121.90 → 65.80 MB |
| PMTiles archive | 198.31 → 115.47 MB | 158.11 → 112.52 MB |

Tokyo requires 308.38 MB less decoded index storage and Kanagawa 166.99 MB less.
These are measured payload reductions, not a measured reduction in total renderer
heap, transition peak or GC pause duration. Retained native buffers and rendered
tile objects have different lifetimes.

## Preservation and publication

`map-creator/src/open_world_map_creator/maps/building_boundary.py` preserves full
intersecting buildings, including buildings crossing borders and buildings in
exclaves. It preserves retained coordinates, holes, heights, foundations and OSM
IDs when present. Native numeric building ordinals are compacted and every sparse
grid reference is remapped; the original grid transform remains unchanged.
Unknown binary flags and empty native results fail closed.

Only `building` / `buildings` MVT layers are filtered. Border-tile features retain
their original protobuf geometry and properties. Fully inside/outside tiles use
their tile footprint for a fast path; buffered geometry is still subject to the
native renderer's tile clipping. A full archive readback verifies an aggregate
digest of every non-building layer at every addressed tile.

Publication verifies original and output hashes, backs up the original index,
archive and manifest, replaces the two artifacts, then updates the manifest last.
An exception during replacement restores the originals. This is not a transaction
for concurrent readers: build offline and use the normal consumer installer.
Existing demand and save data are not regenerated during this rollout.

Resume checks require the same ownership geometry, implementation version,
published bytes and manifest pins. A changed boundary requires unfiltered inputs;
filtering an already reduced package could silently omit newly included buildings.
The two pilot reports retain their subset-source file hash and also record a
geometry hash verified equal to the corresponding full-source feature.

## Generation

Install the `building-boundaries` Python extra on the Runner. The normal
`map-creator/scripts/build_japan_artifacts.ps1` pipeline filters after label
publication and before demand packaging. `--boundary-tile` separates source
prefecture IDs from compatible package IDs (for example `JP_PREF_13` versus
`JP_TOKYO_MAINLAND`). `-SkipMaps` leaves existing building packages alone.

Example standalone invocation, from the repository on the selected Runner:

```powershell
$env:PYTHONPATH = 'map-creator/src'
python -m open_world_map_creator.maps.building_boundary `
  --boundary map-creator/data/sources/japan/geography/prefectures-full.geojson `
  --tile JP_TOKYO_MAINLAND --boundary-tile JP_PREF_13 `
  --index prototype/japan/generated/maps/tiles/JP_TOKYO_MAINLAND/buildings_index.bin.gz `
  --pmtiles prototype/japan/generated/maps/tiles/JP_TOKYO_MAINLAND/tiles.pmtiles `
  --output prototype/japan/generated/maps/ownership-filtered/run/JP_TOKYO_MAINLAND `
  --publish-to prototype/japan/generated/maps/tiles/JP_TOKYO_MAINLAND `
  --backup-root map-creator/data/backups/building-ownership/run
```

The pilot originals remain in the local ignored directory
`.analysis/building-filter-originals/<tile>/`; the full filtered outputs and reports
also remain on richmpc under
`C:/Users/gianc/open-world-runs/polygon-buildings-20260908/output/`.

## Live verification

Consumer `prototype/japan/mod`, manifest `local.japan-open-world`, was rebuilt and
installed with cache revision `japan-owned-buildings-v1`. Installed bundle and
artifact hashes match the built outputs. PMTiles health returned HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

The live regional save switched Kanagawa → Tokyo → Kanagawa without a renderer
reload. Native building counts exactly matched the new indexes. Central Tokyo
and Yokohama rendered buildings normally at zoom 15, with all requested tiles
loaded. Network counts and ID hashes, session, money and elapsed simulation time
remained unchanged. The original camera and pause state were restored.

Switches took 24.989 s and 24.714 s. These are successful smoke checks, not a
controlled before/after speed benchmark. CDP reported roughly 1.30 / 1.33 GB used
heap and 479 / 541 MB backing storage after the respective transitions. There is
no matching baseline, and the coarse in-game heap counter stayed at 1.72 GB;
neither establishes a GC or peak-memory improvement. No heap snapshot or forced
GC was used.

The measurement helper initially stopped when it queried a temporarily missing
map style, then when it attempted to serialize `jumpTo()`'s map return value.
Both were harness errors. The switch itself completed, and the resumed check
verified its original invariants and completed the return trip.

Validation: 10 building-filter tests, 715 platform tests, and 6 Japan consumer
tests passed. Tests cover binary remapping and preservation, holes and exclaves,
MVT/archive preservation, publication rollback, source mismatch rejection, and
verified resume.
