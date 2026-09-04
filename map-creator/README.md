# Open World Map Creator

This top-level package owns geography compilation, demand normalization, road
enrichment, reproducible storage, and Artifact Set publication for every World.
World authors provide a validated directory under `worlds/`; processing code is
not copied into that directory.

The default data root is `map-creator/data`, with content-addressed sources,
resumable work, immutable artifacts, and logs in separate subdirectories. Set
`OW_MAP_DATA_ROOT` to place heavy data elsewhere without changing artifact
identity.

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
