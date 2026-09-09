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
