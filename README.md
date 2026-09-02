# Subway Builder Open World

An experimental open-world layer for Subway Builder. The project splits a large region into native-sized game tiles while preserving a shared rail network, cross-tile commutes, time, finances, schedules, and save identity across tile switches.

The centralized platform currently serves the Northeast Corridor, Tokyo–Kanagawa, and a seven-tile New York corridor. Japan is modeled as one World with a frozen 47-prefecture catalog and independently buildable prefecture Tile Packages.

## What is here

- `open-world-platform/` — the sole shared runtime, mod builder, verifier, installer, worker, and PMTiles-service implementation.
- `map-creator/` — the location-independent map/demand/routing stage graph, Runner adapters, content-addressed storage, and publication gates.
- `worlds/` — validated declarative World Definitions, geography, demand configuration, and pinned source locks.
- `prototype/{nec-corridor,tokyo-kanagawa,ny-state}/mod/` — runnable consumer shells and behavioral compatibility tests; their bundles are generated from the central platform.
- `prototype/kc-two-tile/` — historical pipeline inputs and the broad platform regression fixture; it is no longer a runnable source owner.
- `plans/` and `research/` — feasibility findings and architectural plans.

## Test the runtime

```powershell
cd open-world-platform
npm test

cd ..\prototype\ny-state\mod
npm test
```

Build and installation are deliberately separate:

```powershell
cd prototype\ny-state\mod
npm run build
npm run install:mod
```

## Architecture notes

- [Train state boundaries](docs/train-state-boundaries.md) distinguishes durable train inventory and route assignment from transient rendering and simulation state.

## Data

Raw census/e-Stat inputs, OSM extracts, graphs, Depot output, PMTiles, building indexes, and other generated binary packages are not stored in Git. `map-creator/data` is the default gitignored storage root and may be redirected without changing artifact identity. World source locks and small reproducibility metadata remain in Git.

## Status

This is an active feasibility prototype, not a stable production release. It targets the inspected Subway Builder 1.6.0 runtime and Mod API 1.0.0 surface.
