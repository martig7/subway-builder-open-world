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
`native-saved-reload-v6` guard uses it for ownership checks and cleanup, retaining
its original fallback on unpatched hosts. Explicitly selected saves and tile
navigation handoffs keep their existing ownership rules.

This belongs at the host's preload boundary: Electron freezes the exposed API,
so a renderer mod cannot replace `electron.getPendingSave`. The patch uses
Electron's [contextBridge API](https://github.com/electron/electron/blob/main/docs/api/context-bridge.md)
to retain the existing API and its permission checks. No IPC channel is added.
An upstream host implementation of this transport and compact metadata API
would eliminate the need for this local compatibility patch.

## Install and restore

This is an explicit local compatibility operation, separate from normal mod
installation. Prepare it while the game is open or closed; **close Subway
Builder before applying or restoring**. Run from the repository root:

```powershell
node tools/native-save-read-patch.mjs prepare '<game-directory>' '<staged-app.asar>'
node tools/native-save-read-patch.mjs apply '<staged-app.asar>.json'
node tools/native-save-read-patch.mjs restore '<game-directory>'
```

The preparer accepts only the inspected Subway Builder 1.7.0 preload checksum.
It creates a reviewable archive and checksum plan. The installer checks the
current archive against the plan, retains the exact original at
`resources/app.asar.before-open-world-save-read`, and records a receipt beside
it. Only the preload entry and its ASAR header/integrity metadata change; every
other member retains its original bytes. Restoration verifies both current and
backup checksums before restoring the original archive.

Game updates may replace the patch. The installer and restorer refuse to
overwrite a changed game build. Review an updated preload before extending the
supported checksum; never update that allowlist just to bypass a mismatch.

Build and install the active consumer as usual to deliver the compact identity
read in the runtime. Verify `native-saved-reload-v6` in both its built and
installed bundle. In game, verify:

```js
electron.__openWorldNativeSaveReadVersion
electron.__openWorldNativeSaveReadStats()
```

The version is `native-save-read-json-v1`. An ordinary JSON-backed Native Save
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
