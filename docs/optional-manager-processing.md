
# Optional manager processing

The Windows Open World Manager has three independent switches under **Manager
processing**. All are off for a new installation. Choices are saved in
%LOCALAPPDATA%\metro-maker4\open-world-pmtiles\state\processing-settings.json
and apply to the next operation. The shared tile server must be running.
Closing the manager window leaves its backend available.

**Calculate demand in manager** moves Open World inactive-tile, cross-tile and
cached active-tile calculations into a disposable Node process. The manager reads
inactive demand packages from installed city data. Live inputs and results stream
in bounded pieces; native fare quotes stay authoritative in the game. The same
routing, assignment, finance and capacity algorithms run in either location.
Game-owned ordinary commute workers and initial city loading remain in the game;
this switch does not replace the game's entire simulation.

**Write autosaves in manager** sends the native snapshot to the existing streaming
save writer for compression and atomic publication in the game's current save
folder. Journey history is preserved. Native snapshot generation still happens
in the game, and manual saves retain their existing path. The separate in-game
experimental autosave preference is remembered independently. Selecting manager
autosaves and later turning them off does not enable that preference.

**Name off-tile stations in manager** lets the station repair action read roads
from installed neighboring Tile Packages. It reads one feature at a time and
retains bounded naming candidates. Native naming schemes, formatting and scoring
are preserved. Existing player names and changes made while a request is running
are protected. A station without usable road data remains unresolved. Exactly
tied candidates can differ from the game's spatial-index ordering.

Selected calculation or save failures are reported without retrying heavy work
in the renderer. Cancellation, changed sessions and mod disposal discard obsolete
work. This reduces some allocation peaks; it does not guarantee that every OOM is
prevented.

## Bounds and packaging

Demand jobs run serially with a 2 GiB Node old-space limit and a five-minute
deadline. Uploads are limited to 256 MiB and output to 512 MiB. Job files are
removed on completion or cancellation; abandoned uploads expire. The native
demand cache keeps at most 256 MiB of compressed chunks. Node's old-space limit
does not bound all native allocations or total system memory.

Station naming accepts 32 stations and 256 KiB per request, streams features up
to 512 KiB each, and bounds segment comparisons to five million per station.
Only the server's installed Tile Packages can supply road or demand files.

Build the helper with Node 22 or later using
node open-world-platform/scripts/build-manager-processing.mjs. The Windows
release scripts and npm run build:native / npm run test:native include this step.
Windows support archives contain processing/node.exe, manager-processing.cjs and
the version-matched Node license. The game machine does not need its own Node
installation. Cross-platform demand-helper packaging requires a matching runtime;
the Windows publisher does not ship the Windows runtime in macOS application
archives.

## Verification on 2026-10-10

Active consumer: local.japan-open-world, built from prototype/japan/mod and
installed into %APPDATA%\metro-maker4\mods\local.japan-open-world.
The installed index.js matched the built bundle's SHA-256 and timestamp.
The shared service on port 8799 returned HTTP 200,
native-pmtiles-directory-v4 and manager-processing-v1. The supported mod reload
activated the manager save-choice code and cached simulation generation 25.
Map-move diagnostics were reset before the capture.

- Shared runtime suite: 1,395 passing tests.
- Japan consumer behavioral suite: seven passing tests.
- Native suite: 46 passing tests, including real HTTP control, persistence,
  streamed jobs, separate process execution, cleanup and origin checks.
- Helper parity tests preserve assignment, profile and fare attribution; large
  cross-demand uploads preserve Map/Set semantics without a whole JSON string.
- Windows support ZIP smoke check included the server, Node, helper and license.
- The installed helper completed a live HTTP cross-demand job with 2,000 cohorts
  and preserved native fare callbacks and Map collections.
- In the paused JP_TOKYO_MAINLAND save, an inactive demand profile evaluated
  29,731 populations in 1,653 ms. The helper executable was in the installed
  manager's server/processing directory, separate from the game and tile server.
- The manager autosave streamed 177,817,596 bytes in 340 chunks, wrote a
  32,244,777-byte native .metro file, and completed in 8,890 ms. Snapshot generation
  took 615 ms, with zero omitted journey rows. Native clock and money stayed fixed.
  A streaming verification confirmed the native METR layout, compressed CRC and
  exact 177,817,596-byte snapshot digest without retaining the inflated file.
- Station repair processed 26 blank names, renamed 22 and left four unresolved.
  A separate live Kanagawa road lookup succeeded while Tokyo stayed active.

The diagnostic save is
D:\SubwayBuilder\prototype_autosave_69efc382fff4464d802a0d04a3c7e05d.metro.
The new manager switches were returned to off after verification. The player's
existing Ultra speed and experimental-autosave preferences were preserved.

The current save's national startup did not complete cleanly during repeated
reload captures; successful individual helper jobs and the save/naming checks
establish the offload path, not a full national startup performance benchmark.
