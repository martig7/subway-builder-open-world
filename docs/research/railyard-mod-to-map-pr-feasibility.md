# Railyard mod-to-map PR feasibility

Research date: 2026-09-01

## Outcome

A general mod-to-map dependency feature is feasible and fits Railyard's current
architecture. The useful seam is not a runtime `registerMap()` method in the
generated JavaScript loader. The useful seam is Railyard's content-install
graph: a mod version declares required map listing IDs, Railyard resolves and
installs them, and the existing generated loader automatically registers the
installed maps before game launch.

The smallest acceptance-friendly design is:

1. Extend the existing mod dependency resolver to support typed map
   dependencies.
2. Persist those maps through the existing profile subscription machinery.
3. Include dependency provenance so required/shared maps can be repaired and
   safely retained on uninstall.
4. Add a tiny read-only runtime readiness interface to the generated loader so
   consumer mods can wait for city registration without competing for tile/data
   ownership.

The selected consumer remains manifest `local.nec-corridor-open-world` under
`prototype/nec-corridor/mod`. Public release should choose a stable Railyard
listing ID before publishing.

## Evidence from current Railyard source

Railyard already has most required implementation:

- `railyard/internal/types` distinguishes `AssetTypeMap` and `AssetTypeMod`.
- `Downloader.InstallAsset` dispatches installation by asset type.
- `Subscriptions` already has separate `Maps` and `Mods` buckets.
- `InstallDependency` already accepts an asset type and persists dependency
  subscription intent.
- `ComputeDependencyList` already resolves transitive semver constraints, but
  currently assumes every dependency is a mod.
- `generateMod` reads `Registry.GetInstalledMaps()` and serializes every map into
  the generated loader configuration.
- Launch already starts the native PMTiles server before generating the loader.

Upstream confirms that Railyard generates `com.railyard.maploader` from installed
maps and starts the loopback server at launch:

- [Railyard architecture overview](https://github.com/Subway-Builder-Modded/monorepo)
- [`app_mod.go`](https://github.com/Subway-Builder-Modded/monorepo/blob/main/railyard/app_mod.go)
- [`game_launch.go`](https://github.com/Subway-Builder-Modded/monorepo/blob/main/railyard/game_launch.go)
- [`packages/map-loader/src/main.js`](https://github.com/Subway-Builder-Modded/monorepo/blob/main/packages/map-loader/src/main.js)
- [`packages/map-loader/src/cities.js`](https://github.com/Subway-Builder-Modded/monorepo/blob/main/packages/map-loader/src/cities.js)

The registry analytics pipeline currently reads a flat `dependencies` object
from a mod release manifest, separates `subway-builder`, and passes remaining
entries to Railyard as mod dependencies. Registry metadata is separate from the
hosted artifacts:

- [Registry repository and submission model](https://github.com/Subway-Builder-Modded/registry)
- [Registry mod-manifest validation](https://github.com/Subway-Builder-Modded/registry/blob/main/scripts/lib/mod-manifest.ts)
- [Registry integrity metadata](https://github.com/Subway-Builder-Modded/registry/blob/main/scripts/lib/integrity.ts)

## Recommended interface

Prefer an explicit field over letting a runtime mod append arbitrary city
objects to the loader:

```json
{
  "id": "northeast-corridor-open-world",
  "dependencies": {
    "subway-builder": ">=1.6.0"
  },
  "map_dependencies": {
    "nec-cp00-rp00": "^1.0.0",
    "nec-cp00-rp01": "^1.0.0"
  }
}
```

The production manifest would list all 34 registry map IDs. These are listing
IDs, not runtime city codes. Railyard owns the mapping from listing ID/version to
the installed map's city code.

A namespaced key such as `map:nec-cp00-rp00` inside the existing flat
`dependencies` map could reduce schema churn, but it makes type information part
of string parsing. An explicit typed field is clearer and leaves room for a
future general content graph. Existing flat dependencies remain a backward-
compatible adapter for mod-to-mod requirements.

At runtime, the generated loader should expose a read-only interface installed
synchronously before registration begins:

```js
globalThis.RailyardMapLoader = {
  interfaceVersion: 1,
  ready,
  mapsFor(registryModId) {}
};
```

`ready` settles only after Railyard has registered its cities and installed tile
and data bindings. `mapsFor()` returns an immutable mapping of required registry
map IDs to installed versions and city codes. It does not expose mutation,
installation, or arbitrary city registration.

NEC then stops calling `registerCity`, `setCityDataFiles`, and
`setTileURLOverride` for Railyard-owned maps. Railyard remains the sole owner of
the dynamic server port and bindings.

## Why a loader-only registration hook is insufficient

A method such as `RailyardMapLoader.registerMap(...)` would be a shallow
interface. It could register an already accessible city in the renderer, but it
could not download, checksum, extract, update, repair, profile, or serve the
PMTiles package. Each consumer mod would have to reimplement those behaviors,
and direct game launches would still lack the Railyard server.

The deeper module belongs in Railyard's native install/profile implementation.
The loader interface should only report the result to runtime consumers.

## Lifecycle requirements

- Required dependencies resolve before filesystem mutation.
- A required map is identified by registry ID and resolves to one version.
- City-code conflicts are detected before launch.
- Required maps cannot be silently removed by `skipIncompatibleMaps`.
- Installation failure leaves the previous committed profile usable.
- Explicitly installed maps are distinct from dependency-only maps.
- A shared map remains installed while another root mod or the user owns it.
- Missing/corrupt dependencies produce a repair action before game launch.
- Loader state is immutable and generation-aware across hot reload.

An MVP can retain the existing dependency behavior in which dependencies become
ordinary profile subscriptions and are not automatically removed with the root
mod. That is safe and considerably smaller. Provenance-based orphan cleanup can
follow in a second PR.

## Likely monorepo changes

Backend:

- `railyard/internal/types/registry_types.go`: add typed map-dependency metadata.
- `railyard/internal/downloader/downloader.go`: generalize dependency graph nodes
  from mod ID to `(asset type, asset ID)` and dispatch map installation.
- `railyard/internal/profiles`: persist map dependency subscriptions and later
  provenance.
- `railyard/app_mod.go`: include registry ID/version/mod ownership in the loader
  config; installed-map generation itself already exists.
- `railyard/game_launch.go`: preflight required content before starting servers
  and generating the mod.

Loader:

- `packages/map-loader/src/main.js`: install and settle the readiness interface.
- `packages/map-loader/src/cities.js`: return an immutable registration result
  and report aggregate failures.
- Add focused loader readiness tests.

Frontend:

- Show the dependency maps, total download size, install progress, and missing
  or conflicting requirements.
- Label dependencies as maps rather than linking all dependency IDs to mod
  listings.

Registry coordination:

- Parse and publish `map_dependencies` in integrity/version metadata.
- Validate semver ranges and referenced map listing IDs.
- Regenerate JSON schemas and add validation fixtures.

This is realistically a coordinated monorepo PR and registry PR. A prefix-based
MVP could pass through today's registry dependency map with less registry churn,
but explicit typed metadata is the stronger long-term interface.

## PR slicing

Recommended order:

1. **Loader readiness PR:** small, backward-compatible, useful even when maps
   were installed manually.
2. **Typed mod-to-map dependency PR:** extend the existing resolver and profile
   subscription path, initially retaining dependencies on root uninstall.
3. **Provenance and repair PR:** explicit/transitive ownership, orphan cleanup,
   shared dependency retention, launch repair UI.
4. **Optional bundle/collection PR:** generalize beyond a mod as the root only if
   another real use case appears.

For NEC, the mod itself should be the first pack root. A new abstract bundle type
would be broader but much larger and is unnecessary for the first contribution.

## Local clone status

The implementation clone is `C:\Users\darkd\Downloads\monorepo`. At inspection
time it was on `feat/maploader-driving-routes` with an untracked
`pr-maploader-driving-routes.md`. Its local `origin/main` was dated 2026-07-18,
while current upstream has since extracted the loader to `packages/map-loader`.

Do not add this feature to that branch. Preserve the existing work, fetch current
upstream, and create a new `codex/` feature branch or separate worktree from the
updated `origin/main` before editing.

## Feasibility assessment

- Loader readiness only: high feasibility, small PR.
- Basic mod-to-map installation using existing dependency semantics: high
  feasibility, medium PR.
- Atomic 34-map planning, provenance, repair, and automatic orphan removal:
  medium feasibility, larger multi-module change.
- Full generic content bundles with optional features and conflicts: feasible,
  but premature for the first PR.

The recommended first ask to maintainers is therefore: support required map
listing IDs on a mod version, install them through the existing asset/profile
pipeline, and expose a read-only loader-ready snapshot. That directly solves the
NEC distribution problem without making Railyard NEC-specific.
