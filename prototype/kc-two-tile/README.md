# Kansas City two-tile open-world feasibility prototype

This is a throwaway but executable feasibility slice for two adjacent **25 km × 25 km** Kansas City ownership tiles (`KCW` and `KCE`) with **2 km immutable-data halos**. It tests the risky parts before investing in a national build: native save swapping, crash-safe transition ordering, deterministic inactive-tile catch-up, conserved cross-tile worker cohorts, and seamless rendering from a shared corridor-wide tile archive (`KCOW`).

The result is not yet a polished production mod. The offline runtime and data compiler are implemented and tested, and a real Depot archive has been generated and served successfully; explicit in-game soak testing against Subway Builder 1.6.0 is still required.

## What is implemented

- `pipeline/`: pinned acquisition for KS/MO LODES8 2023 JT01 `main`, `aux`, and crosswalk files; disk-backed crosswalk lookup; streaming corridor filtering; deterministic cohort splitting and gateway projection; documented Subway Builder `points`/`pops` demand output; reproducible manifests; fixture halo clipping.
- `mod/`: transactional `WorldTileRuntime`, fake and real game adapters, package hosting adapter, persistent scoped-storage adapter, diagnostic UI, single-file mod bundle, rollback/idempotency/catch-up tests.
- `schemas/` and `fixtures/`: versioned reference contracts and mass-conservation fixtures.
- `logic-prototype.html`: self-contained state-machine lab for happy path, rollback, duplicate transition, and lazy catch-up scenarios.
- `depot/`: a pinned Docker build for Depot plus a stage-aware corridor generator.
- `tools/serve_artifacts.py`: localhost artifact server with CORS and byte-range support.
- `tools/serve-prototype.ps1`: one command that serves game data on port 8787 and PMTiles Z/X/Y requests on port 8788.

The production adapter is deliberately fail-closed. It expects public API `1.0.0` and the private Zustand actions observed in the installed game 1.6.0: `generateSave`, `loadSave`, `loadInitialData`, and `setTimeConfig`. It never guesses alternate mutator names.

Cross-tile commuters now run in a renderer-safe aggregate ledger. Every bucket is always in exactly one of `atHome`, `queuedToWork`, `toWork`, `atWork`, `queuedToHome`, or `toHome`; morning and evening windows dispatch through shared per-gateway hourly capacity, and all positions are saved with the world. The native demand package remains local-only, so no off-map worker/job points are drawn on either map. The toolbar panel reports both tiles' present, waiting, inbound, and outbound totals. A separate on-demand viewer displays the cross-city census blocks, resident/worker views, paired flows, and individual cohorts without inserting them into native simulation demand. The current 10,000-worker/hour gateway value and 30-minute source travel time are explicit feasibility defaults, not inferred subway service; connecting capacity, travel time, and mode choice to player-built lines is the next model seam. Until then, mode choice is `unknown` and the overlay faithfully uses the game's gray “commutes not calculated” color.

## Quick verification

```powershell
cd "prototype\kc-two-tile\pipeline"
$env:PYTHONPATH = 'src'
python -m unittest discover -s tests -v
python -m kc_world_builder.cli validate-config

cd "..\mod"
npm install
npm test
npm run build

cd ".."
python .\schemas\validate_fixtures.py
```

Open `logic-prototype.html` directly in a browser for the guided transition lab.

## Harvest and compile LODES

Install optional production helpers, then run the pinned acquisition. The six compressed inputs total about **29.5 MB**; decompressed Census-published SHA-256 values and compressed byte counts are recorded in `pipeline/config/sources.lock.json`.

```powershell
cd "prototype\kc-two-tile\pipeline"
python -m pip install -e ".[full]"
$env:PYTHONPATH = 'src'

python -m kc_world_builder.cli acquire `
  --lock .\config\sources.lock.json `
  --raw-dir ..\raw-data\lodes

python -m kc_world_builder.cli build-crosswalk-index `
  --input ..\raw-data\lodes\ks_xwalk.csv.gz `
  --input ..\raw-data\lodes\mo_xwalk.csv.gz `
  --output ..\raw-data\blocks.sqlite `
  --project-wgs84

python -m kc_world_builder.cli normalize-lodes `
  --crosswalk-index ..\raw-data\blocks.sqlite `
  --source KS:main:..\raw-data\lodes\ks_od_main_JT01_2023.csv.gz `
  --source KS:aux:..\raw-data\lodes\ks_od_aux_JT01_2023.csv.gz `
  --source MO:main:..\raw-data\lodes\mo_od_main_JT01_2023.csv.gz `
  --source MO:aux:..\raw-data\lodes\mo_od_aux_JT01_2023.csv.gz `
  --output ..\raw-data\kc-od.jsonl

python -m kc_world_builder.cli compile-demand `
  --od ..\raw-data\kc-od.jsonl `
  --output ..\raw-data\kc-cohorts.jsonl
```

Normalization keeps OD pairs whose home and workplace are both owned by the two prototype tiles. This intentionally excludes outside-corridor commuters because this test has gateways only on the internal seam. A national compiler would replace that filter with the complete tile index.

## Generate the real Depot map

Docker Desktop must be running. The generator downloads the Kansas and Missouri Geofabrik extracts (about 308 MB combined), creates one halo-inclusive `KCOW.pmtiles` archive, and publishes the corridor-wide collision/road files under both logical city codes. Its Docker environment pins Depot commit `ef4ab40dce4b3787e4c994f6c426ddd637d30f05`, Python 3.13.9, Java 21, Planetiler 0.10.2, Tippecanoe 2.79.0, PMTiles 1.31.2, and Mapshaper 0.7.51.

```powershell
cd "prototype\kc-two-tile"
.\depot\build-depot.ps1
```

The first run also downloads Planetiler support data into a persistent `kc-two-tile-planetiler-data` Docker volume. Keeping Planetiler's merge-sort workspace on the native Linux filesystem is required; a Windows/OneDrive bind mount can lose temporary chunks between write and memory-map. Retries are resumable: use `-SkipDownloads`, and optionally `-SkipImageBuild`, to retain valid inputs and completed stages.

The feasibility build produced a **40,101,517-byte** PMTiles v3 archive with 2,572 addressed MVT tiles, zooms 3–15, gzip tile compression, and exact halo bounds `[-94.915135, 38.864653, -94.297676, 39.134463]`. Requests at the Kansas City center returned valid protobuf at zooms 8, 10, 12, and 15.

`KCW` and `KCE` deliberately share the same vector-tile URL:

```text
http://127.0.0.1:8788/KCOW/{z}/{x}/{y}.mvt
```

They remain separate city/save namespaces and receive separate demand packages. Sharing the rendering archive removes duplicated seam geometry and guarantees the same Z/X/Y content before and after a logical tile transition.

## Package demand data

Run this after the LODES harvest/compiler and Depot generator. `package` preserves the real Depot collision/road assets already published into each tile directory and adds demand, cohorts, ledger payloads, and manifests.

```powershell
python -m kc_world_builder.cli package `
  --cohorts ..\raw-data\kc-cohorts.jsonl `
  --output-dir ..\artifacts
```

### Optional build-time road routing

For realistic driving competition, run an OSRM `driving` router built from the
same OSM vintage used by Depot, then add it to the package command:

```powershell
python -m kc_world_builder.cli package `
  --cohorts ..\raw-data\kc-cohorts.jsonl `
  --output-dir ..\artifacts `
  --router-url http://127.0.0.1:5000 `
  --router-profile driving `
  --router-dataset-id kc-osm-2026-08-11 `
  --routing-cache ..\raw-data\kc-driving-routes.json
```

The router is a construction dependency only; the game never contacts it.
Packaging queries each aggregated OD pair and stores only fastest-route seconds
and metres in `demand_data.json.gz` and `cross_demand.json.gz`. The persistent,
dataset-versioned cache makes rebuilds resumable and rejects accidental reuse
after the road graph changes. If no router is supplied, native demand retains
its straight-line 48.2 km/h estimate and cross-city demand retains its
straight-line ×1.3 at 40 km/h estimate.

Use a self-hosted OSRM instance rather than the public demo. OSRM needs an OSM
PBF graph, not Depot's output GeoJSON; for seam-spanning routes, merge or clip
the Kansas and Missouri source extracts into one router graph. Keep the
`--router-dataset-id` tied to the merged PBF hash or other immutable source
identifier.

Each tile receives:

- `demand_data.json.gz`: native `points`/`pops` for trips wholly contained by that tile; cross-tile trips remain aggregate-only in the cohort/ledger package so they do not pile up at gateway nodes;
- `cohorts.json.gz`, `trips.bin`: detailed per-cohort provenance artifacts (`*.bin` is deterministic compact JSON in this prototype, not a final binary codec). They are not loaded by the live JS mod;
- `cross_commutes.json`, `gates.bin`: compact runtime handoff data. `cross_commutes.json` aggregates cross-tile mass by home tile, work tile, and gateway, with a stable bucket ID and prototype travel/capacity defaults;
- `cross_demand.json.gz`: lazy viewer data for every cross-city census-block location and canonical cohort. The KC artifact is about 1.4 MB compressed / 3.9 MB inflated for 13,966 locations and 68,209 pops, so it is loaded only while the viewer is opened;
- `manifest.json`: runtime camelCase contract consumed by the mod. Its tile-relative `runtimeFiles.crossCommutes` and `runtimeFiles.gates` descriptors carry stable paths, hashes, byte sizes, encodings, and roles;
- `build-manifest.json`: reproducibility counts, hashes, and source metadata;
- available map/collision assets produced by the preceding map stage.

## Run in Subway Builder

1. Start both local servers:

   ```powershell
   .\tools\serve-prototype.ps1
   ```

2. From `mod/`, run `npm run build`. Its `postbuild` installer copies the game-ready `dist/` folder to `%APPDATA%\metro-maker4\mods\kc-two-tile-open-world-prototype\` and the four native city-data files into `%APPDATA%\metro-maker4\cities\data\KCW\` and `KCE\`, replacing only those prototype-owned directories. The game requires `/data/<city>/...` paths here; its binary loader does not support HTTP absolute URLs.
3. Enable the mod and choose either KC prototype city. Open **World tiles** from the native toolbar. Its tile atlas uses drag panning and cursor-anchored scroll zoom; the slippy survey grid changes resolution with map zoom. Hover or keyboard-focus a logical ownership tile to outline it, then select it to checkpoint the active save and switch through the game's mounted Remix router. The people button opens **Cross-city demand**: switch between residents and workers, click a demand bubble for its paired-area lines and pop list, then click a pop for its exact home/work line.

The mod-side tile index lives in `mod/src/tile-catalog.js`. Tile IDs, ownership bounds, display names, native city definitions, initial views, and atlas fitting derive from that catalog. The atlas automatically fits a wider or taller catalog and renders any number of entries; extending the prototype still requires corresponding generated packages and pipeline configuration for each added tile.

Tile checkpoints contain the player-built network and game globals, but deliberately omit Subway Builder's `compressedDemandData`, route thumbnail, and timelapse images. Static local demand is reloaded from the destination tile package. Embedding it in every native snapshot made an empty two-tile world-state file roughly 445 MB and forced a full clone/JSON rewrite on every switch. The first launch after upgrading from an older prototype save performs a one-time compaction; later switch commits stay small.

Native manual saves and autosaves are paired with mod-world checkpoints by the save name supplied to `onGameSaved`/`onGameLoaded`. Loading an older autosave restores its matching commute ledger, tile snapshots, finances, and exact clock instead of combining it with the newest external mod state. The storage adapter retains the 10 newest named checkpoints per game session; overwritten save names replace their prior checkpoint, and expired saves start fresh mod state rather than inheriting a newer world.

The bundle defaults to artifacts at `http://127.0.0.1:8787` and tiles at `http://127.0.0.1:8788`. Set `globalThis.KC_TWO_TILE_ARTIFACT_BASE` or `globalThis.KC_TWO_TILE_TILE_BASE` before mod initialization to override either origin.

## Current go/no-go boundary

Offline evidence is positive: transaction rollback, idempotent duplicate requests, mass conservation, lazy/eager catch-up equivalence, manifest resolution, current LODES8 crosswalk ingestion, Depot asset generation, PMTiles Z/X/Y serving, and the inspected 1.6.0 capability boundary are covered by tests or concrete artifacts. The remaining decisive experiment is live: round-trip a small native network 100 times, then measure transition p50/p95, renderer working-set drift, hook recursion, and save integrity. Until that passes, this is an implementation-ready feasibility prototype—not proof that a national open world is production-safe.

See the full milestone and acceptance plan in `../../plans/kansas-city-two-tile-mod-plan.md`.
