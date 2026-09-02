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
