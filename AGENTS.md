# Open World Agent Guide

## Start changes from clean version control

Before starting any new feature or change, run `git status --short`. If the
working tree contains tracked or untracked changes, stop before editing,
building, or generating files and ask the user how to handle the existing work.
Do not infer whether it should be committed, stashed, discarded, or included in
the new change.

Use a dedicated branch for feature work. Create branches and make coherent
commits as needed while completing the user's request; separate approval is not
required for normal local version-control operations. Before beginning the next
feature or change, make sure the prior work is committed and the working tree is
clean unless the user explicitly directs otherwise.

Completion criterion: name the active branch and confirm `git status --short`
is empty, or identify the exact user-authorized changes that remain.

## Start by selecting the runnable mod

Treat source ownership, build ownership, and runtime ownership as separate facts.
The shared implementation lives under `prototype/kc-two-tile/mod/src`, but the
game may be running a different consumer bundle. Identify the user's active mod
before building or installing anything.

Use these signals together:

| Runnable mod | Source directory | Manifest ID | Runtime signals |
| --- | --- | --- | --- |
| Kansas City prototype | `prototype/kc-two-tile/mod` | `local.kc-two-tile-open-world-prototype` | `KCW`, `KCE`, `[KC two-tile]` |
| New York canary | `prototype/ny-state/mod` | `local.ny-state-six-tile-canary` | `NY_*`, New York canary logs |
| Northeast Corridor | `prototype/nec-corridor/mod` | `local.nec-corridor-open-world` | `NEC_*`, `[NEC]` |
| Tokyo–Kanagawa | `prototype/tokyo-kanagawa/mod` | `local.tokyo-kanagawa-open-world` | `JP_*`, Tokyo–Kanagawa logs |

Read `*/mod/manifest.json` for mod identity. Generated demand and tile packages
also contain files named `manifest.json`; they are data manifests and are not
installable-mod selectors.

Several mods can be present under the game `mods` directory at once. Presence on
disk proves availability, not which consumer owns the current city/runtime.

Completion criterion: name the active manifest ID and the consumer mod directory
that must produce the runtime bundle.

## Understand the source-to-bundle graph

`kc-two-tile/mod/src` is the shared implementation hub. New York, NEC, and
Tokyo–Kanagawa import many modules directly from it, including runtime, adapters,
projection hooks, and geographic UI. Editing a shared KC source file changes
those consumers only after each intended consumer is rebuilt.

Every mod has an independent `dist/index.js` and independent installed directory.
Building or installing the KC prototype does not update the NEC, New York, or
Tokyo bundle. A successful shared-source unit test also does not prove that the
active game bundle contains the change.

For domain terminology and ownership boundaries, read `CONTEXT.md`. For save,
finance, or persistence decisions, also read the relevant file under `docs/adr`.

## Build and test the selected consumer

Use this sequence for any runtime change:

1. Run the tests at the source seam. Shared KC changes normally require the KC
   suite, plus the active consumer's suite when it has consumer-specific behavior.
2. Build from the active consumer mod directory, not from the directory where the
   imported source happened to live.
3. Verify the consumer's `dist/index.js` contains a unique marker for the change.
   Prefer an exact function name, version constant, or diagnostic stage. Broad
   terms such as `sourceSnapshot` can match unrelated code.
4. Install that same consumer bundle.
5. Verify the installed `index.js`, its timestamp, and the same unique marker.
6. Reload the mod or restart Subway Builder, reset diagnostics, and reproduce.

Useful commands from a mod directory:

```powershell
npm test
node scripts/build-mod.mjs
node scripts/install-mod.mjs
```

Package lifecycle behavior differs:

- KC and New York define `postbuild`; `npm run build` also installs. Use
  `node scripts/build-mod.mjs` when a workspace-only build is intended.
- NEC and Tokyo separate build and install. Their `npm run build` does not deploy.
- NEC's build embeds the generated catalog and packages all selected tiles. A
  source-only KC build cannot stand in for it.

Completion criterion: tests pass, the selected consumer's `dist/index.js` has the
marker, and no different mod was installed as a proxy.

## Install into Subway Builder deliberately

Installed mods live under:

```text
%APPDATA%\metro-maker4\mods\<manifest-id-suffix>
```

Install scripts replace the exact mod directory and may also replace generated
city data under `%APPDATA%\metro-maker4\cities\data`. These are external writes;
resolve the manifest ID and exact target before approving or running them.

After installation, prove disk state rather than relying on installer output:

- Inspect the installed manifest/bundle for the selected mod ID.
- Compare the installed bundle timestamp with the just-built `dist/index.js`.
- Search both files for the same unique implementation marker.
- Confirm the game has reloaded the bundle; a correct file on disk is not proof
  that an existing renderer process is executing it.

## Handle the NEC PMTiles service safely

The NEC installer copies the selected tile packages and ensures a local PMTiles
service on `127.0.0.1:8799`. The server may execute scripts from the installed
NEC mod directory, which can make Windows reject directory replacement with
`EBUSY`.

When the installed NEC directory is locked:

1. Check `http://127.0.0.1:8799/_health` and require the
   `X-PMTiles-Server-Version` header.
2. Identify the owning process by command line. Accept only a process whose
   command references the installed NEC `start-tile-server.ps1` or
   `native-pmtiles-server.ps1` and port `8799`.
3. Stop that verified process only. The PID file under
   `%LOCALAPPDATA%\metro-maker4\nec-corridor-pmtiles` may be stale, so a PID file
   alone is insufficient authority to terminate a process.
4. Run the NEC installer again.
5. If file and city-data copying succeeds but automatic health checking fails,
   start the installed script with `-Background` and recheck `_health`.

Treat installation as complete only when the installed NEC bundle has the change
and the PMTiles health endpoint returns HTTP 200 with the expected version.

## Account for hot reload and retained state

The mod stores guards and diagnostics on long-lived globals, MapLibre objects,
and `map.__deck`. Hot reload can therefore execute new module code while retaining
an old wrapper closure.

When changing wrapper or guard behavior:

- Increment its generation/version constant.
- Preserve cleanup that restores the native method before installing the new
  wrapper.
- Add a regression test that seeds the previous generation and proves attachment
  replaces both the patch object and wrapper function.

Performance diagnostics are cumulative until explicitly reset. Before a clean
capture, reload the intended mod and run:

```js
__enableOpenWorldMapMovePerfDebug({ reset: true })
```

A clean capture starts again at `probe-1`. To prove a particular build is active,
add or inspect a build-specific diagnostic marker; restarted probe numbering by
itself proves only that profiler state was reset.

## Definition of done

A mod change is delivered only when all of the following are true:

- The active runnable mod was identified from its manifest/runtime signals.
- Shared and consumer-specific tests relevant to the change pass.
- The active consumer—not merely the shared KC source project—was rebuilt.
- The correct installed bundle contains the unique change marker.
- Required local services are healthy after installation.
- The game reloaded the bundle and a reset runtime diagnostic demonstrates the
  new behavior.
