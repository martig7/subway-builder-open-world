# Japan main/release integration — 2026-09-05

Main and `codex/japan-romanized-labels` were merged without conflicts. The
geographic overlay, catalog runtime, detailed/display boundaries, selector
names, and demand definition remain identical to Japan commit `6a0e3eb`.
The merged platform retains main's native manager/release work and the Japan
branch's numeric hover IDs, delayed LOD thresholds, detailed islands,
boundary-first land/building placement, OSRM/ferry/water routing, and source
labels with Japanese fallback.

Japan remains `local.japan-open-world`, built from `prototype/japan/mod`, so its
save/storage identity and tile IDs do not change. The central builder reads
root `VERSION` (currently `0.5.0`) exactly as NEC's build on main does. Japan's
author is `Giancarlo Martinelli (gcm)`, matching NEC's release manifest author.

## Shared tile server

Japan declares `runtime.tileServerProvider: shared-native-v4` on port **8799**.
Shared consumers no longer bundle the legacy PowerShell PMTiles implementation.
The central development installer uses the existing official native executable,
requiring `native-pmtiles-directory-v4`, and writes a schema-1 installed-World
registration into the official per-user registry:

```text
%LOCALAPPDATA%/metro-maker4/open-world-pmtiles/state/worlds/
```

Before changing installed files, it validates the existing registrations and
rejects overlapping tile IDs, incompatible ports, or different data roots. It
delegates shutdown to the official executable, which verifies process identity
and the instance token. It registers only the selected World, leaving other
registration files untouched, and starts the service with the union of all
registered tile IDs. Health checks require the exact union, data root, v4
header, and a nonempty Japan MVT response.

This development install reuses an already installed official manager's support
files; install the official manager first. It does not create a standalone Japan
setup package or add a release-catalog selection card. The existing manager's
Start/Restart still includes Japan through the shared registry. Keep the support
installation available while this development World uses it.

For the one-time migration, stop only a command-line-verified old Japan server
on 8801 before installing; it may otherwise retain city-package locks. Future
Japan installations use the shared lifecycle and do not start a second server.
No NEC packages or saves are replaced by the Japan installer.

## Verification

- 494 platform tests pass, including boundary LOD/hover and new shared-registry
  union/conflict tests.
- 3 Japan consumer tests pass.
- 18 native release/manager/server tests pass.
- Read-only preflight locates the installed official 0.5.0 server and validates
  adding all 47 Japan tiles alongside the 34 NEC tiles.

The selected Japan bundle must be rebuilt and installed after integration.
Installation verification must include release version/author, retained
boundary/label markers, exact bundle hash and timestamp, the 81-tile shared
health response, and shutdown of the old 8801 service. In-game reload remains
the user's step; installed-file checks alone cannot prove renderer execution.
