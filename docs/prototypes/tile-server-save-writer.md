# Tile-server save writer prototype

Branch: `codex/tile-server-save-prototype`. Tested September 13, 2026 against
Subway Builder 1.7, native payload schema 4, and the national Japan consumer
`local.japan-open-world` (`prototype/japan/mod`). No game bundle or ASAR changes.

The prototype establishes that an authenticated loopback writer can bypass the
slow Electron object handoff and produce ordinary, loadable `.metro` saves.
It is an optional alternative while the developer's planned save improvements
are pending. Re-measure the native path after that update before retiring the
alternative; an announcement alone is not a performance result.

## Measured results

### September 19: buffered encoding and batched uploads

The `codex/streaming-save-progress` change removes automatic native fallback and
adds phase/elapsed-time reporting (`tile-save-controller-v7`). Previously, a
30-second routing settle timeout or a writer failure could launch native saving;
transfer failures also disabled the experimental toggle for subsequent saves.
The generic zero-byte label did not distinguish routing waits from synchronous
snapshot generation. If native saving blocked immediately after overlay removal,
the renderer could also leave the old overlay painted until native work ended.
These are reproduced code paths, not proof of which path caused a particular
uncaptured screenshot.

A local differential replay used the same captured Japan Native Save in both
versions, with the existing journey-history omission applied equally. The
178,573,883-byte snapshot went through an isolated instance of the real native
writer, publishing only into the ignored benchmark directory.

| Measurement | Previous client | Buffered/batched client |
| --- | ---: | ---: |
| Encoding plus upload and disk commit | 17.113 s | 7.121 s |
| Encoder time during that replay | 11.939 s | 3.674 s |
| HTTP transfer time | 4.403 s | 2.996 s |
| Upload requests | 1,363 | 341 |
| Largest measured encoding slice | 29.2 ms | 9.5 ms |
| Compressed native file | 30,920,338 bytes | 30,920,338 bytes |

This single replay was 58% faster. It excludes live routing waits and native
snapshot generation, and uses Node's `setImmediate` between encoding chunks;
it is not a measured in-game end-to-end saving time. A separate encoder-only
replay fell from 8.873 s to 2.950 s. Both versions produced exactly the same
decompressed native snapshot (SHA-256
`8b1541831b8b3adc4e3b6566117c7b5ca730be203e344c1b12005ba4ec725d22`).
Verification checked the METR header, compressed CRC32, native bundle marker,
container wrapper and snapshot digest. No payload fields or wire protocol changed.

The local harness and evidence are ignored under
`.analysis/save-stream-performance/`: `benchmark.mjs`, `before.json`, `after.json`,
`replay.mjs`, and `replay-results.json`. Regression coverage verifies no automatic
fallback, cancellation during settling, writer preflight before pausing, phase
reporting, ordered batched JSON/checksums and ambiguous commit receipts. All 950
platform checks and seven Japan checks passed. The remaining live validation is
to reload the Japan bundle and capture the controller's phases and final timings;
the game's diagnostic endpoint was unavailable during this change.

Japan was rebuilt from `prototype/japan/mod` and installed as
`local.japan-open-world`. Built and installed `index.js` hashes and timestamps
matched (SHA-256 `a33f00d5f2f89611122a41aa02b1f9c99b051fe2cbb733ccd8ca01efdbd0739c`,
2026-09-19 22:55:16 UTC); both new implementation markers were present. The
configured service on port 8799 returned HTTP 200 with
`native-pmtiles-directory-v4` and `stored-driving-routes-v1`. This verifies disk
installation and service health, not execution by the existing game renderer.

### September 13: initial in-game prototype

The paused Tokyo network had 967 stations, 227 routes, 946 trains and about
190.9 MB of native save JSON. Its session, clock and money stayed unchanged.

| Measurement | Result |
| --- | ---: |
| Recent native autosave completion | 93.3 seconds |
| Native recorder's longest unsampled gap | 90.9 seconds |
| Prototype through the mounted autosave callback | 19.1 seconds |
| Prototype through the game's normal autosave timer | 20.5 seconds |
| Prototype heartbeat's longest gap in the callback test | 378 ms |
| Final controller, complete callback / longest heartbeat gap | 18.2 seconds / 286 ms |
| Main heap before / observed peak in the 45-second capture | 1,447 / 1,631 MiB |
| All measured V8 heaps, observed allocated peak | 2,958 MiB |
| Prototype service working memory after two saves | 84 MiB |
| Ordinary `.metro` output | 29.3 MB |

These are observed samples, not a bound on every GC pause or allocation. The
simulation and editing remain paused during streaming so the snapshot can
reference existing native data without a second full graph copy. This removes
the long unresponsive interval, but does not yet provide uninterrupted play.
Map interaction has not been separately benchmarked during saving.

The offline replay decompressed a real native autosave, streamed its native
save JSON through the writer, and verified identical decompressed container
bytes using SHA-256. The 190.9 MB replay took about 10.2 seconds including its
verification, with the Node process limited to 128 MiB of old space. Native
loader acceptance was checked through `loadAndSetPendingSave`, with the previous
pending save restored afterward. The existing recovery guard subsequently
discovered and staged a prototype file from the normal saves folder by itself.
This verifies native decoding and recovery selection; it is not a full
save/reload/playthrough test of every game feature.

Local captures are Git-ignored under `.analysis/save-writer`: `replay-result.json`,
`native-loader-result.json`, `automatic-result.json`, `automatic-memory.jsonl`,
and `memory-summary.json`. They contain no control tokens or debugger addresses.
`final-runtime.json` and `input-guard.json` verify the installed
`tile-save-controller-v2` implementation, including shortcut interception while
its progress button has focus. The installed Japan bundle's SHA-256 is
`614E3ECE55A61ACD0F457958B51E0D598B7EF2B41770425B7516956374B2538A`.

## How it works

The mod's existing native autosave callback guard delegates to the experimental
controller only after explicit session activation. It pauses the native clock,
blocks game input, and requires a ready World with no active native routing or
cached midnight calculation. Native `generateSave` still generates and validates
the complete save. Cached-mode clock and train rebasing remain in that wrapper;
only the reference-sharing pass intended for Electron's bridge is skipped.

Prototype uploads omit the native journey-history rows (`compressedDemandData.c`,
about a third of a large save); the demand model, rail topology and train
inventory stream untouched. The game's loader treats a missing history as empty
and its schema marks the blob optional, while ordinary native saves keep the
full history. The live game is never modified.

JSON encoding yields between roughly 128 Ki-character chunks. The encoder buffers
scalar tokens within each traversal instead of yielding every token through its
ancestor generators. Uploads combine those chunks into roughly 512 KiB requests
(always below the server's 4 MiB cap), without reducing encoding yield frequency.
One authenticated request is outstanding at a time, with sequence numbers and SHA-256 checksums.
The server validates JSON incrementally, writes gzip directly to a temporary file,
and publishes only after the final counts, native envelope, and renderer state
checks pass. The renderer checks the clock, ledger, session, city and relevant
root references again before publication. Arbitrary third-party mutations within
objects are not covered by those identity checks; broader mod compatibility is
outside this prototype's validation.

The native container uses a 4,096-byte METR header, an empty auxiliary index,
the native `mainSave`/`autosaves` wrapper, compressed-payload CRC32, and the native
bundle marker. The server never builds a full save object graph. The save root
comes from the game's configured save folder or an explicit `--save-prototype-root`.
The initial tested service ran separately on port 8800 with a 256 MiB managed heap cap,
leaving the production map service and crash recorder on port 8799.

Files are named `prototype_autosave_<GUID>.metro` inside the configured native
saves directory. Five completed prototype files are retained per native session
and city; existing ordinary saves are untouched. Failed uploads remain unpublished,
aborts delete their temporary files, and old abandoned prototype uploads are
cleaned on startup or the next save. A missing commit response can recover a small
completed receipt. Since `tile-save-controller-v7`, an enabled experimental writer
never automatically falls back to native saving. Gate rejections, cancellation,
and transfer errors resume playback and leave the experiment armed for the next
attempt. They explicitly report that no save was written; the panel offers an
experimental retry. If a commit response and its recovery receipt are both lost,
the outcome is instead reported as unconfirmed, with a request to check the save
list before retrying. A committed save cannot be undone by cancelling its request.

The writer is checked before pausing the game. The dialog and panel distinguish
checking the writer, waiting for journey calculations, preparing the native
snapshot, opening the upload, encoding/uploading, and finishing on disk. They
show elapsed time throughout and bytes during upload/finalization. Snapshot
generation is still synchronous native work: its label paints first, but its
timer cannot repaint during a blocked renderer slice. **Cancel save** aborts the
experimental attempt; it never launches a native save. Native autosaving is
selected only while the experimental toggle is off, and that selection is
identified in the panel and activity diagnostics.

## Run it

Build and install the active Japan consumer using the repository's normal
workflow. Build the native service with `dotnet build` or the native test command.
Launch Subway Builder through the manager with diagnostics, load Japan, and reload
the installed mod. The prototype resets to disabled on mod reload or game restart.

In a separate PowerShell terminal at the repository root, start the experimental
service. Use the **actual native save folder** for `--save-prototype-root`:

```powershell
$env:DOTNET_GCHeapHardLimit = '0x10000000'
& '.\open-world-platform\native\src\OpenWorld.TileServer\bin\Release\net8.0\open-world-tile-server.exe' serve --root "$env:APPDATA\metro-maker4\cities\data" --tiles JP_TOKYO_MAINLAND --port 8800 --state-root '.analysis/save-writer/state' --save-prototype-root 'D:\SubwayBuilder'
```

The save root defaults to the game's configured save folder
(`customSavesDirectory` from settings); `--save-prototype-root` still
overrides it. The loaded mod connects on its own: it probes port 8800 first, then the
World's tile server, once at startup and again whenever the Map rendering
panel opens while unconfigured (re-probes are throttled to one per minute, so
a stopped writer cannot spam the console), so no `--enable` pairing step is
needed and server restarts cannot strand the toggle. Game
requests ride without the per-boot instance token; other origins keep
requiring it, so the diagnostic launcher below remains available for explicit
control sessions:

```powershell
node --max-old-space-size=128 open-world-platform/scripts/prototype-tile-save.mjs --world japan --port 8800 --server-state .analysis/save-writer/state --enable
```

The Map rendering panel always exposes **Experimental tile-server autosaves**.
Unchecking it immediately returns future autosaves to the native path. This
prototype does not persist activation or add a manager checkbox; checking the
box stays opt-in per session, and authentication tokens are never printed or
saved in the mod bundle.

The same script without an action reports compact status. `--save` invokes the
mounted autosave callback once for measurement; `--disable` restores future native
saves. A timed-out diagnostic command may run after an existing native freeze
ends, so query status before retrying. Stop the prototype service only after
disabling it and letting any active save finish:

```powershell
& '.\open-world-platform\native\src\OpenWorld.TileServer\bin\Release\net8.0\open-world-tile-server.exe' stop --port 8800 --state-root '.analysis/save-writer/state'
```

The in-game progress dialog reports completion, and normal save discovery/recovery
uses the resulting file. The native autosave HUD's own timestamp is not updated
by the replacement callback in this prototype. Manual native saves remain normal.

## Validation and remaining experiments

Platform and Japan tests cover existing runtime behavior; focused tests cover
JSON value preservation, chunk failures, receipt recovery, state changes,
playback restoration, input blocking, hot wrapper replacement, cached rebasing,
and prevention of automatic native fallback. Native tests cover binary layout, CRC, split UTF-8 input,
truncated uploads, mismatched envelopes, atomic publication and scoped retention.
All 916 platform checks, seven Japan checks and 37 native checks passed across
the full and focused runs. One synthetic-builder fixture initially failed because
Windows placed its temporary project on another drive; it passed with the test
temporary directory placed on the workspace drive. The final input-guard test
was added and run after the full suite.

Before promoting this to a default transport, measure saves during ordinary
unpaused gameplay and cached mode, exercise full native reloads and update
compatibility, and compare save-time memory peaks with the forthcoming native
implementation. A smoother snapshot strategy would be a separate change: it
must preserve the Native Save's authoritative topology and ledger without
reintroducing a large renderer copy or a parallel save catalog.
