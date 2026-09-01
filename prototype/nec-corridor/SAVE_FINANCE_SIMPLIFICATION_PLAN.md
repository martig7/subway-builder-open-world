# NEC Save/Load and Finance Simplification

## Outcome

Subway Builder is the sole financial ledger. The NEC mod may calculate and
post off-tile revenue, but it never owns balance, expenses, financial history,
or save-correlated finance state. Native save/load events cannot execute a
finance operation.

## Invariants

1. `onGameSaved` performs no mod persistence, settlement, snapshot generation,
   snapshot restoration, or finance work.
2. `onGameLoaded` reads the already-loaded native state and invalidates derived
   demand/revenue caches. It never writes balance or financial history.
3. NEC posts revenue only. Every expense remains a native-game responsibility.
4. Each revenue hour has a deterministic receipt stored with native financial
   history. Repeating an hour is a no-op.
5. Off-tile profiles and mode share are derived caches. Missing, stale, or
   incompatible cache data is discarded and recomputed; it is never recovered.
6. Sidecar persistence contains topology/navigation state only. It excludes
   wallet, financial history, finance cursors, finance profiles, and pending
   financial attribution.
7. Only an explicit tile-selection transition may invoke the internal native
   load required to change city views.

## Deep module

The new `NativeRevenueAccrual` module has this external interface:

```js
revenue.replaceProfiles({ networkHash, profiles });
revenue.invalidate();
await revenue.postHour({ worldId, hour, activeTileId, projection });
```

Its implementation owns hourly calculation, deterministic receipts,
idempotency, native revenue posting, chart attribution, and telemetry. It has no
expense input and exposes no recovery or save/load methods.

## Execution

1. Add `NativeRevenueAccrual` with production and in-memory adapters exercised
   through the same interface.
2. Add a finance-blind sidecar mode and make it the NEC default. Do not migrate
   old financial sidecar fields into this mode.
3. Route NEC hourly ticks through the new module; startup/load only rebuilds
   profiles and never performs catch-up settlement.
4. Make NEC `onGameSaved` observational only. Remove save tokens, checkpoints,
   and internal snapshot work from that hook.
5. On true native load, discard derived caches and adopt native time, balance,
   history, and complete network without financial reconciliation.
6. Delete NEC reachability to finance recovery, expense profiles, settlement
   journals, finance handoffs, finance quarantine, and save-correlated world
   checkpoints.
7. Replace implementation-detail tests with interface tests proving save
   transparency, hourly idempotency, expense non-interference, older-save
   behavior, mod reload behavior, and explicit tile-switch behavior.
8. Run the shared and NEC suites, build, install, verify bundle hash, and probe
   the PMTiles server.

## Cutover policy

This is a breaking sidecar schema cutover. Existing native balance and history
remain authoritative. Legacy mod finance state is ignored, not recovered.
Topology/navigation state may be retained only when it is compatible with the
new finance-blind schema; otherwise it is rebuilt from native state and packaged
demand.
