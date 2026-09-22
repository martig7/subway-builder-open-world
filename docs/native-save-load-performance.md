# Native save loading performance

Large Native Saves can stall Subway Builder 1.7.0 while Electron copies their
deeply nested response from the isolated preload into the game renderer.
Reading and decompressing the file is comparatively fast. Open World's saved
reload guard previously requested another full pending payload merely to read
its identity, duplicating the expensive transfer during startup.

The optional host compatibility patch in `src/host/native-save-read-bridge.js`
(under `open-world-platform`) sends the pending save as text and reconstructs it
in the renderer. Optional `undefined` fields, negative zero and non-finite
numbers are restored separately. Shared references, cycles, sparse arrays,
custom objects and unsupported values use the original native transfer. Native
Save contents, topology, finance and selection remain authoritative. This does
not trim completed commutes or financial history, change the save format, or
disable Electron context isolation.

The host also exposes a compact pending-save identity read. The shared runtime's
`native-saved-reload-v7` guard uses it for ownership checks and cleanup, retaining
its original fallback on unpatched hosts. Explicitly selected saves and tile
navigation handoffs keep their existing ownership rules.

This belongs at the host's preload boundary: Electron freezes the exposed API,
so a renderer mod cannot replace `electron.getPendingSave`. The patch uses
Electron's [contextBridge API](https://github.com/electron/electron/blob/main/docs/api/context-bridge.md)
to retain the existing API and its permission checks. No IPC channel is added.
An upstream host implementation of this transport and compact metadata API
would eliminate the need for this local compatibility patch.

## Load Game menu

The verified Subway Builder 1.7.0 Load Game handler previously decoded the
selected file into the renderer and then sent the full save back to the main
process with `setPendingSave`. The compatibility installer now patches that
specific renderer handler to call `loadAndSetPendingSave(path, autosaveId)`, the
same native staging operation used by Resume. It then navigates using the
compact city code returned by the host. On a host without that API, the handler
retains its original loading path. A failed native stage still shows the Load
Game error and does not navigate.

The installer checks the original renderer and preload checksums, verifies the
exact handler text before changing it, and compares every byte of the staged
archive with the two expected entry replacements. It refuses a different game
build or handler. The original archive remains available for exact restoration.

## Renderer-local tile handoffs

Host bridge `native-save-read-json-v2` also supplies
`renderer-local-native-handoff-v1`. For a same-session tile switch, the runtime
stages one destination-bound Native Save in the renderer. The existing native
initializer still loads the destination geography and calls `getPendingSave`,
but that read consumes the local payload without a main-process round trip.
The loader and exact native-handoff verifier are unchanged.

Before navigation is permitted, the host acknowledges a full recovery copy in
the main process. The renderer sends it through a
[structured-clone message channel](https://www.electronjs.org/docs/latest/tutorial/message-ports)
to the isolated preload, which invokes the existing native pending-save API.
Neither direction sends the full tile handoff through `contextBridge`.
Shared references remain shared; the save is not expanded into JSON for this
path. Context isolation stays enabled, and no native IPC channel or filesystem
permission is added. This removes the slow save round trip, not all copying or
the need for a native snapshot.

The local payload has one owner: recovery ID, transition, native session,
source and destination. Consumption releases the bridge's graph reference.
Abandonment and superseded navigation cancel only that owner. Native save
selection invalidates the local stage before it starts asynchronous work;
queued native mutations and stage epochs prevent a delayed backup from
replacing a newer selection. Unsupported hosts keep the previous transport.
A failed or uncertain fast stage aborts rather than retrying through the slow
bridge. Normal native removal clears the recovery copy after consumption.

The runtime keeps the independent snapshot needed to verify native loading,
then releases it before destination simulation preparation. Diagnostics expose
only counts, identities and timing through
`electron.__openWorldLocalHandoffStats()` and the tile-map-ready sample's
`nativeSaveTransport` and `nativeSaveStageMilliseconds` fields.

## Install and restore

This is an explicit local compatibility operation, separate from normal mod
installation. Prepare it while the game is open or closed; **close Subway
Builder before applying or restoring**. Run from the repository root:

```powershell
node tools/native-save-read-patch.mjs prepare '<game-directory>' '<staged-app.asar>'
node tools/native-save-read-patch.mjs apply '<staged-app.asar>.json'
node tools/native-save-read-patch.mjs restore '<game-directory>'
```

The preparer accepts only the inspected Subway Builder 1.7.0 preload and
renderer checksums.
It creates a reviewable archive and checksum plan. The installer checks the
current archive against the plan, retains the exact original at
`resources/app.asar.before-open-world-save-read`, and records a receipt beside
it. Preparing an installed patch verifies its receipt and the original backup,
then stages an upgrade from that verified original. Applying the upgrade keeps
the original backup and retains the previous installation until the replacement
receipt is published. Stale plans, changed receipts and interrupted transaction
files are rejected. Only the verified preload and renderer entries and their
ASAR header/integrity metadata change; every other member retains its original
bytes. Restoration verifies both current and
backup checksums before restoring the original archive.

Game updates may replace the patch. The installer and restorer refuse to
overwrite a changed game build. Review an updated preload before extending the
supported checksum; never update that allowlist just to bypass a mismatch.

Build and install the active consumer as usual to deliver the compact identity
read in the runtime. Verify `renderer-local-native-handoff-v1` in both its built
and installed bundle. In game, verify:

```js
electron.__openWorldNativeSaveReadVersion
electron.__openWorldNativeSaveReadStats()
electron.__openWorldLocalHandoffVersion
electron.__openWorldLocalHandoffStats()
```

The read version is `native-save-read-json-v2`; the local handoff version is
`renderer-local-native-handoff-v1`. An ordinary JSON-backed Native Save
should report a JSON read and no native fallback. Diagnostics return counts and
encoding time, never the save payload.

## Measured Japan result, September 12, 2026

The affected Kanagawa save was 19.1 MB compressed and 176.5 MB when decoded,
with 678 stations, 4,382 tracks, 53 routes and 418 trains.

| Measurement | Before | After |
| --- | ---: | ---: |
| Complete resume to runtime ready | About 260 seconds | 26.45 seconds, original file |
| Normal Resume button, fresh game process | — | 25.76–30.11 seconds, equivalent native autosave |
| Isolated full pending-save read | 109.94 seconds | 5.49 seconds including validation and decoding |

The baseline full resume used CPU profiling; the isolated 109.94-second read
and the fixed full resumes did not. Later background map tiles finished shortly
after runtime readiness and were verified loaded. These figures are local
measurements of this save, not universal loading guarantees.

The transported JSON's SHA256 matched before/after reconstruction. The loaded
balance, clock, pause state, financial-history entries, fleet ownership, train
assignments, station coordinates, native session and all network entity IDs
also matched the protected original save. The game remained paused throughout
the comparisons. Native autosaves continued normally; the original file was
retained in a separate diagnostic backup and restored after normal retention
pruned it.

Validation: 820 platform tests and 7 Japan behavioral tests passed. On a Windows
checkout on E:, temporary synthetic build fixtures must also be on E: because
the existing builder uses relative module imports. The active consumer was
`prototype/japan/mod`, manifest `local.japan-open-world`; its built and installed
bundles matched. The shared PMTiles service returned HTTP 200 with
`native-pmtiles-directory-v4` and `stored-driving-routes-v1`.

Local captures, the original save backup and detailed checks are under the
Git-ignored `.analysis/japan-save-startup` directory. Regression tests cover the
transfer boundary, optional values, native fallbacks, identity-only reads,
concurrency and errors, archive member preservation, rollback, and refusal to
overwrite an updated host.

## Load Game menu and preview check, September 19, 2026

The following records the diagnosis before the menu patch above was implemented.

The current 1.7.0 installation still has the `native-save-read-json-v1` preload
patch. Its renderer entry is `dist/renderer/public/index-CM0DI1Ho.js`, SHA-256
`99fd5ed94f0c77636f32fe1f21c6165bc6649ea528beb03bee7ad87d4b8bd67d`.

Resume uses `electron.loadAndSetPendingSave(path, autosaveId)`, which stages the
save in the main process and returns a small result. The Load Game menu's
`handleLoadSave` instead calls `loadGame(path, autosaveId)` and then
`electron.setPendingSave(fullSave)`. Those two extra full-object transfers are
outside the existing pending-save read patch. Replaying the installed handlers
with instrumented native API fixtures confirms two full-save transfers before
navigation for Load Game and zero for Resume. This is a reproducible path
difference, not a new measurement of Electron transfer time. A menu improvement
should preserve the selected path and autosave ID while using the same native
staging operation as Resume.

The native `generateSave` also skips `generateRouteThumbnail` above 100 routes.
The save card renders the stored `thumbnail` or `routeThumbnail`; it does not
reconstruct the network from the save's tracks. The recent native and experimental
Japan saves inspected both contained 1,275 stations, 251 routes, 8,174 tracks,
and 1,046 trains, with no thumbnail. This explains a missing preview independently
of the experimental writer's journey-history omission. A preview improvement
needs to generate and publish the existing native thumbnail field for larger
networks, with a bounded drawing cost; it must not trim saved topology.

Read-only checks verified native container offsets, gzip decoding, and CRC32
for the retained native fixture and an available older experimental save. The
experimental save's empty journey-history array remains separate from its demand
model and network fields. The recent experimental file was removed from the
live save directory while native autosaves continued, after its initial read;
that initial compact inspection is retained separately from later checks.

Local evidence and runnable handler replay are Git-ignored under
`.analysis/save-loading-compatibility`. The running game had no active diagnostic
endpoint, and Computer Use did not receive approval to inspect its window.
Consequently this check did not perform a live menu load, measure its duration,
or verify the on-screen preview. These game-side compatibility gaps remain open.
