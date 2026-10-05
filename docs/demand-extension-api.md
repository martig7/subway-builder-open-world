# Open World demand extensions, version 1

Japan and Northeast Corridor consume the same shared implementation in
`open-world-platform/src/runtime/demand-context.js`. It publishes
`globalThis.SubwayBuilderOpenWorldDemand` independently of the existing
`SubwayBuilderOpenWorld` schematic context bridge. Providers register before
startup with demand unavailable, so an extension can safely load before either
World consumer finishes preparing native demand.

## Context and ownership

`getContext()` returns `null` outside an owned World city, or a context with:

- `version`, `providerId`, `definitionId`, `resolvedWorldId`;
- `tileId`, `cityCode`, `nativeSessionId`, `epoch`, `providerGeneration`;
- `demandReady`, `demandRevision`;
- `tileBounds: [west, south, east, north]`, `basemapRevision`, `sources`.

`resolvedWorldId` identifies the player's runtime World. `definitionId`
identifies the geographic definition and must not be used to share player state.
Ledgers and owned demand are stored separately for each player World, tile and
extension. Network topology can remain shared at World scope.

Call `subscribe(listener)` for context changes; it returns an unsubscribe
function. The global event is
`subway-builder-open-world-demand-context`. Read the latest context after each
notification. `demandReady` also requires completed native demand restoration and
simulation preparation; map readiness alone is insufficient.

## Mutation contract

`readState(extensionId, expectedContext)` returns a promise for the extension's
serialized ledger, or `null`. Stale identities, generations or full state
revisions are rejected.

`runMutation(extensionId, expectedContext, {mutationId, apply})` returns a promise
for the committed context. `mutationId` must identify one operation uniquely
across reloads. `apply()` executes synchronously using supported game demand
editor APIs and returns only its owned snapshot:

```js
{
  ledger: JSON.stringify(ledger),
  points: [{id, location: [longitude, latitude]}],
  pops: [{id, residenceId, jobId, size, drivingSeconds, drivingDistance,
    homeDepartureTime, workDepartureTime}]
}
```

Include actual live pop IDs and departure times from native demand, not planned
IDs. Include only materialized owned points; existing native endpoint points
remain in the installed base demand. `commitState` is a convenience for already
captured snapshots and accepts an optional `mutationId`.

A failed durable write pauses the owned game and blocks saving. Retry the same
operation ID and original expected context to persist the captured snapshot
without repeating its native edits. A throwing `apply` can be retried after its
caller rolls back the editor changes. Successfully returned malformed output is
captured before validation and will never re-execute native edits on retry.

## Native saves and routing

Each commit durably writes a compact immutable extension record and an immutable
World manifest before stamping `financialHistory.openWorldDemandCheckpoint` in
the native state. Native saves carry this marker; finance and topology remain
native authority. Loading an older save selects its exact marker, not the newest
sidecar record. A missing referenced checkpoint fails closed.

Native save generation holds a context lease through synchronous or asynchronous
generation and final save preparation. Owned demand edits pause for that interval;
success or failure releases it. A native context replacement retires old leases,
and ordinary cities and disposed providers acquire no lease.

Tile loads restore sparse owned demand after the native package/network restore
and before native commute preparation. Regenerated pop IDs are remapped in ledger
`pops`, `tombstones` and `pendingRemovals`; native point `popIds` come from the
supported editor. Actual regenerated departure times are persisted for inactive
routing. Both JSON and compressed-byte worker evaluation merge the same sparse
overlay into pristine packaged demand.

Full state revision changes on every committed ledger update. An independent
immutable routing key changes only when point/pop scalar demand changes, so
pressure-only ledger commits preserve routing caches. Unique routing keys also
separate two edited branches loaded from one older checkpoint. Worker completion
and staged finance publication check demand freshness before accepting results.

Pending hot reload transfers only a captured snapshot whose live demand object,
player World/session/tile and pre-mutation native checkpoint still match. A real
native load replaces that object and discards the takeover. The old generation
cannot stamp a newer generation's native state.

Immutable records are retained to preserve arbitrary older native saves. Garbage
collection requires an explicit retained-save reference inventory; this version
does not prune records or simulate growth in unloaded tiles.
