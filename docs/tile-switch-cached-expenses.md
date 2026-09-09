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
No infrastructure-accounting change is included here.

Validation: 730 shared-platform tests and 24 Japan/NEC consumer tests passed.
The investigation and fix used code and unit tests only, as requested. No game
interaction, consumer installation, or draft-release artifact replacement was
performed; runtime verification remains outstanding.

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
cursor-loss issue is not fixed by the train-time ordering change.

Temporary measurement wrappers were removed and mods reloaded after the test.
Draft release downloads were not replaced. Raw local measurement receipts are
under `.analysis/expense-live-*.json` and `.analysis/expense-install-receipt.json`.
