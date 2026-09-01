# Subway Builder Open World

An experimental open-world layer for Subway Builder. The project splits a large region into native-sized game tiles while preserving a shared rail network, cross-tile commutes, time, finances, schedules, and save identity across tile switches.

The current real-game pilot covers a seven-tile New York corridor from New York City toward Albany. A smaller Kansas City prototype contains the generalized runtime, adapters, tests, schemas, and the original two-tile data pipeline.

## What is here

- `prototype/kc-two-tile/mod/` — shared transactional runtime, native game adapter, cross-tile routing and demand, network projection, accounting, UI, and tests.
- `prototype/kc-two-tile/pipeline/` — reproducible LODES acquisition and demand-compilation pipeline.
- `prototype/ny-state/mod/` — New York pilot registration, recovery configuration, installer, and game-specific policy.
- `prototype/ny-state/src/` — New York tile catalog, Voronoi demand aggregation, routing, benchmarking, and package construction.
- `plans/` and `research/` — feasibility findings and architectural plans.

## Test the runtime

```powershell
cd prototype\kc-two-tile\mod
npm install
npm test

cd ..\..\ny-state\mod
npm test
```

The New York installer is intentionally local to Subway Builder and runs as the mod package's build step:

```powershell
cd prototype\ny-state\mod
npm run build
```

## Architecture notes

- [Train state boundaries](docs/train-state-boundaries.md) distinguishes durable train inventory and route assignment from transient rendering and simulation state.

## Data

Raw Census LODES files, OSM extracts, OSRM graphs, Depot output, PMTiles, building indexes, and other generated binary packages are not stored in Git. They are large and reproducible from the pinned source/configuration files in each prototype. See the prototype READMEs for acquisition and build commands.

## Status

This is an active feasibility prototype, not a stable production release. It targets the inspected Subway Builder 1.6.0 runtime and Mod API 1.0.0 surface.
