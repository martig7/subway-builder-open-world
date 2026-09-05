# NEC inactive-tile revenue: drive-to-station parity

## Confirmed discrepancy (2026-09-05)

The supplied NEC save ending `3acc3792cd3245a28c2839be72ce0281.metro`
loads successfully and has no unmatched packaged demand IDs. Its active tile
is `NEC_CP03_RP02`. All 14,368 saved native population IDs match the installed
package. This is separate from the earlier external save with Induced Demand
additions.

The native ledger records $140,256,725 revenue on each of days 79–82, against
roughly $257m expenses. The pre-fix independent inactive-tile forecast was
$140,139,925. Thus completed but inaccurate estimation, not missing startup
work, accounts closely for the observed low-income period.

Of 4,699 stored transit paths, 4,685 contain a driving segment. The previous
shared estimator supported only walking access. A sampled population with
88 native transit riders was rejected as `origin-outside-walk-range`; feeding
the native transit time into our mode chooser reproduced all 88 riders.

## Implementation

- Read the native 1.7 `featureFlags.DRIVE_TO_STATION_ACCESS` boolean from
  localStorage at the adapter seam. Missing, false, malformed, or inaccessible
  settings mean disabled. Never enable the feature or infer the current setting
  from historical saved paths. The native feature defaults to false.
- Carry live pathfinding rules into canonical and localized network profiles.
- Use native drive access speed: packaged driving distance / driving seconds /
  time-of-day congestion multiplier. Invalid evidence does not invent a speed.
- Allow driving only to the first station, within the configured drive
  catchment (native standard default: 420 seconds); retain walking as an option.
  Do not introduce driving egress, driving gateway transfers, parking charges,
  or a fare for a driving-only journey.
- Evaluate home-to-work and work-to-home independently. Driving access is
  directional; a usable outward trip does not establish a usable return trip.
- Include rules in profile signatures and estimator cache identity; upgrade
  evaluator schema to 4. Recompile on setting changes during lifecycle
  recalculation or hourly settlement, preserving native receipt deduplication.
- Expose current `routingRules` in the existing read-only revenue snapshot.

## Validation and limits

The isolated full-save replay uses the real WorldTileRuntime and estimator,
installed NEC demand, and an in-memory native-store adapter. It verifies that
boot preserves the provided network and ledger. It does not reproduce the UI
or run the native simulation engine.

| Forecast | Daily revenue |
| --- | ---: |
| Saved directional native choices | $636,960,587.50 |
| Previous off-tile estimator | $140,139,925.00 |
| Fixed estimator, drive enabled, native 45-minute walk rule | $655,551,862.50 |
| Fixed estimator, drive disabled, same walk rule | $125,080,937.50 |

Enabled forecast error fell from -78.0% to +2.9%. These are fare-revenue
forecasts, not operational profits. The disabled result must not be compared
as a parity target against saved choices calculated with drive access enabled.
The remaining error includes differences between our independent router and
native scheduling/path selection; this is not a claim of exact native parity.
Station-type-specific catchment multipliers remain a separate parity concern.

Regression coverage: `open-world-platform/tests/drive-to-station.test.js`.
Platform suite: 504 passed. NEC consumer suite: 18 passed.

Built and bundle-only installed the official `northeast-corridor-open-world`
consumer from `prototype/nec-corridor/mod`, preserving its version and author.
Installed bundle hashes match the build; the shared PMTiles server is healthy.
No city packages, player saves, or game feature settings were changed.
The game debugging connection was unavailable, so the user's current live
feature setting and reloaded in-game behavior still require confirmation.
