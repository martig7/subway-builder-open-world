# Remembered runtime mode choices

`runtime-mode-preferences-v1` remembers the Ultra-high-speed and experimental
tile-server autosave choices per runnable mod. The two booleans live in renderer
local storage, under `open-world:mode-preferences-v1:<manifest-id>`. They apply
across native saves, Tile Views, mod reloads and full game restarts. New users
default to native simulation and native autosaves. A hot upgrade from an older
runtime adopts its current choices when no saved preference exists.

Only an explicit toggle changes a preference. Stopping simulation for a native
load, tile handoff, game end or mod disposal does not save an unintended off
choice. Startup restores Ultra after network/finance preparation, reusing valid
assignment data through the existing bounded preparation path. Delayed work
checks runtime ownership and load generation, and rereads the latest choice so
turning Ultra off while loading prevents a later enable.

The autosave choice is restored immediately, separately from writer discovery.
If the experimental writer is unavailable, attempts remain visible failures;
they do not silently use native transport. Reconnecting the writer keeps the
choice, and the user can turn the experimental option off while disconnected.
Selecting a mode does not trigger an immediate save or change the native
autosave interval or retention settings.

No network, finance, tokens, worker results or save payloads enter the preference
record. Malformed, unsupported or non-boolean values cannot enable modes.
Unavailable storage leaves the current choice usable; the compact preference
diagnostic reports whether persistence succeeded.

Regression coverage includes fresh instances, on/off persistence, mod isolation,
storage failures, live upgrade migration, deferred startup, cancellation during
restoration, lifecycle shutdowns, and unavailable/reconnected save writers.

Validation on 2026-09-20: all 1,116 platform/Kansas City regression tests and
7 Japan consumer tests passed. The bundle from `prototype/japan/mod` was
installed as `local.japan-open-world`; built and installed SHA-256 hashes match
(`671955ce98260a453749521a5ae3387bc377ab0fb0e63cc75f730be1555c6530`), including
the preference version marker. The local PMTiles service returned HTTP 200 with
`native-pmtiles-directory-v4`. The running player's existing on/on choices were
persisted using the preference module before restart. Full game restart
verification is pending the player's stopping point; installation alone does
not replace the running module.
