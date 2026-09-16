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

JSON encoding yields between roughly 128 Ki-character chunks. One authenticated
request is outstanding at a time, with sequence numbers and SHA-256 checksums.
The server validates JSON incrementally, writes gzip directly to a temporary file,
and publishes only after the final counts, native envelope, and renderer state
checks pass. The renderer checks the clock, ledger, session, city and relevant
root references again before publication. Arbitrary third-party mutations within
objects are not covered by those identity checks; broader mod compatibility is
outside this prototype's validation.

The native container uses a 4,096-byte METR header, an empty auxiliary index,
the native `mainSave`/`autosaves` wrapper, compressed-payload CRC32, and the native
bundle marker. The server never builds a full save object graph. It requires
`--save-prototype-root`; normal server startup exposes no writer endpoints.
The tested service runs separately on port 8800 with a 256 MiB managed heap cap,
leaving the production map service and crash recorder on port 8799.

Files are named `prototype_autosave_<GUID>.metro` inside the configured native
saves directory. Five completed prototype files are retained per native session
and city; existing ordinary saves are untouched. Failed uploads remain unpublished,
aborts delete their temporary files, and old abandoned prototype uploads are
cleaned on startup or the next save. A missing commit response can recover a small
completed receipt. Pre-snapshot gate rejections (busy routing, changed tile) and
per-save user cancels keep the experiment armed for the next save and invoke
the current native autosave callback. Only post-snapshot transfer failures
disable the experiment. Disposed runtimes or changed sessions cannot invoke an old
fallback callback.

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
overrides it. The loaded mod connects on its own: it probes the World's tile
server first, then port 8800, and retries while unconfigured, so no `--enable`
pairing step is needed and server restarts cannot strand the toggle. Game
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
and native fallback. Native tests cover binary layout, CRC, split UTF-8 input,
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
