# Cached-mode expense spikes on tile changes

The world-grid navigation path captured its lean native snapshot before cached
simulation finished exiting. That snapshot copies the live train objects and
bypasses the `generateSave` wrapper, which normally adjusts frozen train timing
anchors. The later `onGameEnd` cleanup rebased the live trains, but could not
repair the snapshot already retained for the destination.

Native train operating costs use elapsed game time minus each train's
`operationalTime.lastChargedAt`. Loading the frozen anchors therefore made time
already paid through cached estimates chargeable again as native operating cost.

The fix awaits cached-mode exit before staging world-grid navigation. This
settles the remaining estimated interval and rebases the live train anchors
before the lean snapshot is captured. Cached mode already exited during tile
navigation; the change moves that existing operation earlier.

## Reproduction and verification

`node --test --test-name-pattern="grid tile switch excludes" open-world-platform/tests/runtime-startup-cancellation.test.js`

The regression drives the real grid callback and cached simulation controller,
then captures through the production adapter's lean snapshot path. Navigation
and package loading are stubbed. Twenty cached ticks advance 4,800 seconds;
10 native operating seconds were unpaid before cached mode began. Before the
fix, the destination snapshot exposes 4,810 chargeable seconds. After the fix,
only the original 10 remain. Both paused and unpaused cases pass, and train
arrival anchors move forward by the cached interval.

The local extracted native renderer's operating-cost calculation confirms that
this gap is multiplied by the train's hourly cost. A separate infrastructure
cursor observation was not the explanation for the large spike: its native
charge is one fixed five-minute interval, rather than the entire elapsed gap.
The infrastructure follow-up is documented below.

Validation: 731 shared-platform tests and 24 Japan/NEC consumer tests passed.
The initial investigation and train-timing fix used code and unit tests only;
the subsequent live verifications are recorded below.

## Live verification — September 9, 2026

Rebuilt the NEC consumer at `prototype/nec-corridor/mod` and installed the same
bundle into both enabled NEC installations: `local.nec-corridor-open-world` and
`northeast-corridor-open-world`. Both installed bundle hashes matched the build
(`cff45f6760d580da0a030efccae1267347e166a1c4ac0b48ae74113bb68e0d50`),
including the awaited cached-mode exit immediately before staging navigation.
The game reloaded both bundles at version 0.6.0. The shared tile server returned
HTTP 200 with `native-pmtiles-directory-v4`.

Used the player's saved NEC network: 42 stations, 3 routes, 14 trains. Reset the
map performance diagnostics, ran 20 cached ticks (4,800 simulated seconds), and
clicked the neighboring tile through the native map selection layer:
`NEC_CM03_RM02` → `NEC_CM02_RM02`.

- All 14 trains retained exactly their pre-cached unpaid operating-time gaps.
  No train regained any of the 4,800 seconds already paid through estimates.
- The first normal native tick posted $68,437.50 in train operating costs.
  The two trains charged had already accumulated 900 unpaid seconds before
  cached mode began.
- Exiting cached mode separately settled $2,741,065.65 of pending estimated
  expenses before navigation. This settlement remains visibly batched; the
  test does not claim that the expense display becomes smooth.
- Outward navigation completed in 6.211 seconds; return navigation in 6.641
  seconds. The original tile, camera, pause state and speed were restored,
  with all 3 routes and 14 trains retained. The test advanced game time by
  80 minutes plus one second; it did not rewind the Native Ledger.

The return also confirmed a separate infrastructure issue: its billing cursor
was 4,019,637 before navigation and zero after restoration. Native code can then
post one additional five-minute maintenance interval. The first measured tick
posted $198,579.30 track maintenance and $75,555.56 station maintenance. This
cursor-loss issue was independent from the train-time ordering change.

Temporary measurement wrappers were removed and mods reloaded after the test.
Draft release downloads were not replaced. Raw local measurement receipts are
under `.analysis/expense-live-*.json` and `.analysis/expense-install-receipt.json`.

## Infrastructure cursor follow-up

Subway Builder 1.7 keeps `lastInfrastructureChargeTime` only in its live store:
native save generation omits it, and native save loading resets it. Tile
navigation now adds the live cursor to both full and lean runtime snapshots,
transfers it with the Native Ledger fields, and restores it after the native
loader completes. The exact cursor is retained so a real unpaid partial interval
remains due.

The regression starts with a live cursor of 4,019,337 and a stale snapshot
cursor of 3,300, simulates the native loader resetting it to zero, and verifies
that restoration returns it to 4,019,337 with the original 300-second unpaid
interval. The complete platform and Japan/NEC suites passed.

For the live check, both enabled NEC installations received bundle hash
`80f490802e66d5c44239856fd5818784e7932ac29dcaed78e514ccb23bf83fce`
with diagnostic marker `native-tile-snapshot-copy-v2`. Starting from a corrected
one-second unpaid gap, 20 cached ticks advanced 4,800 seconds and navigation from
`NEC_CM03_RM02` to `NEC_CM02_RM02` restored a one-second gap. The next native
tick posted only $68,456.51 of due train operating cost: no track, station, or
grade-crossing maintenance was posted. Returning to the original tile preserved
the cursor again, leaving a 1.5-second gap after that native tick.

The original tile, camera, pause state, speed, 42 stations, 3 routes and 14
trains were restored. This second test advanced the Native Ledger by 80 minutes
and one native half-second and did not rewind it. Draft release assets were not
replaced. The raw receipt is `.analysis/expense-cursor-live-final.json`.

## Network edits during cached simulation — remaining large spike

The player's newer NEC autosave (42 stations, 4 routes, 26 trains) contains an
hour with $558.4 million in train operating expenses, versus roughly $0.8–5.5
million in surrounding hours. The player confirmed editing the network or
trains while cached mode was enabled. The earlier checks did not exercise that
case and did not establish that every large spike was fixed.

Native route regeneration creates replacement train objects while retaining
their `operationalTime.lastChargedAt`. Cached simulation previously restarted
each replacement object's frozen interval. Saving or switching then excluded
only time since the edit, making the already estimated interval before the edit
payable again. The v6 controller tracks the billing interval by train ID and
billing cursor separately from the physical train object's timing interval.
New trains and explicitly changed billing cursors begin a new interval.

The new regression failed before the change with 4,810 chargeable seconds
instead of the original 10. It now verifies both save generation and cached-mode
exit. Additional coverage checks new trains, reset billing cursors and replacement
of a v5 hot-reload wrapper. All 733 platform and 24 NEC/Japan tests passed.

Live reproduction used JavaScript/CDP after computer-use initialization failed
and the player authorized JavaScript control. The cached-mode switch, play/pause
and map tile selections used the game UI. To exercise the native network-edit
path without altering track geometry, the test invoked native `setTracks` with
the existing tracks and their IDs as the regeneration set. All 26 train objects
were replaced; all 26 billing cursors were preserved.

- Old build: after 4,800 cached seconds, regeneration and one further cached
  second, native save generation exposed a 4,826-second billing gap instead of
  26. The generated save stayed in memory. Before running native simulation,
  the test-created excess gap was corrected from the captured timing evidence;
  no historical expenses or wallet balance were refunded.
- Fixed build: after 5,040 cached seconds, regeneration and one further cached
  second, the generated save retained the correct 26-second maximum gap.
  Switching `NEC_CM04_RM02` to `NEC_CM03_RM02` preserved every train's exact
  pre-cache gap and the two-second infrastructure gap. The next four native
  half-second ticks posted no expense actions. The return switch preserved the
  resulting gaps again. Switch durations were 7.078 and 6.095 seconds.

Built `prototype/nec-corridor/mod` and installed the bundle in both enabled NEC
directories (`local.nec-corridor-open-world` and `northeast-corridor-open-world`).
Both installed files matched the build timestamp and SHA-256
`75536b872047568c182f6fdc4c74d0f146ac0969bbcc6253499fe9cf134c72cb`.
The reloaded game reported `open-world-cached-simulation-v6`; reset diagnostics
captured the return switch. PMTiles remained healthy with HTTP 200 and
`native-pmtiles-directory-v4`. City packages and draft release downloads were
not replaced.

The original tile, camera, ultrafast speed and paused state were restored with
42 stations, 4 routes and 26 trains. Cached mode is off, as it was immediately
after loading the autosave. The investigation advanced the game clock by
5 hours, 36 minutes and 6 seconds, with ordinary simulated finance retained.
Historical chart spikes remain. Temporary expense wrappers and timers were
removed. Local receipts are `.analysis/spike-old-edit-failure.json`,
`.analysis/spike-fixed-edit-save.json`, `.analysis/spike-fixed-destination.json`,
`.analysis/spike-fixed-native.json` and `.analysis/spike-fixed-final.json`.
