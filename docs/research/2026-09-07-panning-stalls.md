# Panning stalls in the Japan regional save

## Runtime and reproduction

Active consumer: `prototype/japan/mod`, manifest `local.japan-open-world`.
The live Japan save has 316 stations, 53 routes, 2,294 tracks, 244 trains and
28,709 active-tile pops. Tests used cached Ultra simulation, then paused the
same live save. No native save was loaded or simulation time rewound.

The reproduction pans ten times over ten seconds in each mode, records animation
frame gaps and browser long tasks, and captures a CPU profile. The final test
also invokes the existing native autosave callback during movement and waits
for it to finish after movement stops. Camera and pause state are restored.

| Capture | Running worst frame | Paused worst frame | Frames at least 250 ms |
| --- | ---: | ---: | ---: |
| Original profile | 2,166.7 ms | 2,273.2 ms | 4 |
| Final foreground profile | 153.4 ms | 16.6 ms | 0 |

Final p95 frame times were 20.0 ms running and 6.8 ms paused. The worst observed
frame fell by 93.3%. These are representative captures on the same live network,
not identical simulation-time replays. Simulation time advanced between runs;
the final capture additionally forced an autosave during movement.

`essential: true` is needed on automated map animations when reduced motion is
enabled. Background-window captures are invalid: the base game throttles to
about one frame per second while the CPU profile is mostly idle. One capture
was also discarded after the player interrupted it.

## Causes and changes

1. The read-only Electron reload bridge made the previous reload guard fall
   back to copying a full live recovery snapshot every 15 seconds. This crossed
   the Electron bridge repeatedly and caused frame gaps up to 2,273 ms, even
   while paused. The replacement polls completed save headers and loads changed
   files into the main process through `loadAndSetPendingSave`. It never creates
   a periodic live World snapshot.
2. The native save hook built a World view solely to read its ID. The ID now has
   a scalar accessor. The before profile attributed roughly 237 ms to this
   discarded view during an autosave.
3. Ledger assertions recompiled and cloned unchanged journey templates. Balance
   validation now skips that compilation; route templates are still built when
   assigning or migrating journeys. Conservation checks remain enabled.
4. Runtime notifications constructed another full view for listeners that only
   needed an event or the active tile ID. Internal listeners now opt out of that
   copy. This removed a separately reproduced 423 ms routing-result frame.
   Subscribers requesting the existing summary view retain that contract.
5. Identical route lists share references in outgoing cached-mode saves, with
   unchanged native JSON values, route order, IDs and record counts. Live state
   is not mutated.
6. Native autosaving still copies a large object graph synchronously through
   Electron. The mod defers the native autosave callback until the map has been
   still for 1.5 seconds, for at most 30 seconds. It preserves the native interval,
   save format, retry logic and status UI. Manual saves are unaffected.

## Recovery correctness

The reload guard uses completed Native Saves as its authority and retains the
main-process pending payload when autosave retention prunes its source file.
Native file IDs identify ownership because the loader substitutes file mtime
for the header timestamp. Explicit pending selections are preserved.

New saves from the current load's timeline may replace the selected save; a
newer historical branch of the same native session may not. Replayed bootstrap
load events preserve the current checkpoint. The live game emits two such
events before the mod becomes ready. Actual subsequent loads reset the timeline.

Leaving the game cleans up only this guard's pending file. Generation replacement
restores and replaces wrappers, cancels stale work, and retains only file identity
across mod reload. The original explicit tile-navigation handoff remains intact.

The autosave scheduling adapter recognizes the mounted `AutosaveManager` callback
using three verified function markers. Unknown game builds retain unmodified
native autosaving. Its React ref accessor follows callback updates and restores
the latest native callback on disposal.

## Validation and delivery

643 platform/fixture tests and 4 Japan behavioral tests pass. Regressions cover
discarded views, journey validation, save-value equivalence, bounded autosave
deferral, session changes, callback replacement, explicit save selection, file
timestamp differences, pruning, bootstrap replay and guard cleanup.

Built and installed Japan bundle:

- SHA256: `968e3562a810a444f4c0ecfda9019a8e024dd65ed38dac20fdc937dddb61e36d`
- UTC timestamp: `2026-09-07T23:23:50.5905028Z`
- Markers: `open-world-cached-simulation-v5`, `native-autosave-idle-v2`,
  `native-saved-reload-v3`, `native-save-reference-sharing-v1`, `eventOnlyListeners`.
- Installed destination: `%APPDATA%/metro-maker4/mods/japan-open-world`.
- PMTiles: HTTP 200, `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

Raw CPU profiles and machine-local diagnostic scripts remain ignored under
`.analysis`. The stable regressions above live in the platform and fixture suites.

The final live generation was 15. The native autosave completed with no error;
the reload guard subsequently staged newer saves and skipped unchanged files.
The smoke test confirmed synchronous saves, no duplicate finance posting,
preserved cached train positions, zero invalid population assignments and
4,011 transit directions with route segments. Disabling cached mode resumed
native train movement. The original rail network counts remained unchanged.
The game was left paused with cached Ultra enabled, matching the player's latest
pause state, and the temporary performance probes were disabled.

## Limits

Native saving still took approximately 0.9–1.0 seconds in post-fix profiles; this
work now runs after interaction stops. Continuous movement beyond the 30-second
deferral limit can still overlap a save. Recovery restores the latest staged
completed save, so unsaved progress is not a recovery checkpoint. Mod reload,
pending-save staging and refresh were tested live; a destructive renderer crash
was not induced.
