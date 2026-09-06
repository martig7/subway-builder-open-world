# Open World Platform

This package is the single owner of shared browser runtime and runnable-mod
behavior. Its public seams are:

- `startOpenWorld({ definition, artifacts, subwayBuilderHost })` for runtime;
- `ow-mod build` for generated entry points, workers, manifests, and packages;
- `ow-mod verify` for identity, release, and World Definition hash checks;
- `ow-mod install` for safe consumer installation and PMTiles lifecycle.

World-specific identities, Tile Views, ports, basemap revisions, source locks,
and demand adapters live in `worlds/<world>`. Consumer directories contain
behavioral compatibility tests and command redirects, but are not source owners.

```powershell
npm install
npm test
node cli\ow-mod.mjs validate --all
node cli\ow-mod.mjs build --world worlds\nec-corridor --mod prototype\nec-corridor\mod --artifacts prototype\nec-corridor\generated
```

Build and install are separate operations. Verification requires the platform
release, manifest ID, World ID, and canonical World Definition SHA-256 to be
present in the selected consumer bundle.

All consumer shells use `npm run install:mod`; `npm install` only sets up
dependencies. Normal builds reuse unchanged staged Tile Packages. Installation
compares artifact identities and copies only changed or damaged city files, so a
runtime-only update leaves those files and the running tile server untouched.
SHA-256 values are cached against each file's path, size, modification time, and
change time. Use `npm run build -- --repair` or `npm run install:mod -- --repair`
to rehash and replace every managed artifact. The central CLI accepts the same
`--repair` option.

Embedded-consumer package manifests use schema version 2: native city assets stay
in each tile directory, while `cross_commutes.json` and `cross_demand.json.gz`
live once at the package root and are embedded in `index.js`. Installed city
directories and release data ZIPs contain only the native assets. The builder
still reads old standalone packages whose world files live in the initial tile;
the historical HTTP adapter and its fixtures keep their per-tile contract.

World Definitions share the JSON Schema in `contracts/world-definition.schema.json`.
Ajv validates it in the platform and Python `jsonschema` validates the same file
in the map creator. Contained-path and catalog-reference checks remain semantic
checks in the loaders. Both test suites run the same invalid-definition fixtures
and validate every checked-in World.
