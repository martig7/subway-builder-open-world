# Bounded native network projection plan

Status: implemented as an installed-canary candidate  
Date: 2026-08-12  
Purpose: bound Subway Builder's native renderer to the active tile and its one-tile ring while preserving one authoritative multi-tile rail network, complete route station lists, accurate schedules, and cross-tile simulation.

Implementation note (2026-08-12): the first canary uses the documented conservative fallback. Fully contained routes and tracks remain native; crossing tracks and partial routes are clipped into a read-only MapLibre overlay rather than synthetic native topology. Complete route descriptors, station order, schedules, cycle time, fleet, and finance remain in `world.globalNetwork`. Constructed-network hooks reconcile allowed edits and restore rejected edits; the tile atlas surfaces the warning and suggested tile. This avoids exposing shortened cycle times or dangling synthetic objects to the native scheduler while preserving the intended renderer bound.

This plan refines the global-network separation described in [New York State large-test plan](new-york-state-large-test-plan.md#r2--separate-the-global-network-from-native-tile-snapshots). It replaces the current behavior that copies the complete shared transit network into every active native save.

## 1. Decision summary

Use two representations of the player network:

1. **Authoritative global network** — complete stations, tracks, routes, trains, schedules, fares, and stable identities for the entire world.
2. **Native projection** — a disposable, reproducible working set containing the active tile, up to eight addressable neighboring grid cells, and a small outer guard band.

The native projection exists to render and edit nearby infrastructure. It is never a second source of truth. Before a tile switch or save, permitted native changes are reconciled into the global network; rejected changes are rolled back to the last valid projection.

Define the window by Chebyshev grid distance:

```text
visible(tile) = max(abs(tile.column - active.column),
                    abs(tile.row - active.row)) <= 1
```

Use the union of those ownership polygons plus a **250 m guard band** as the render envelope. The guard band is for numerical stability and coherent boundary terminals, not an additional editable tile.

## 2. Required invariants

1. Every real station, track, route, and train has one stable global ID.
2. A native projection can be deleted and reproduced from the global network without losing player state.
3. No projected fragment may overwrite the unseen portion of a global route.
4. Complete route station order, timetable headways, train schedules, fare assignment, and full-route cycle time remain global.
5. Cross-tile routing, mode share, revenue, and ridership use the global network or its saved profiles, never clipped projection geometry.
6. Native state contains no ordinary station marker outside the 3×3 render envelope except a preserved boundary dependency allowed by the projection validator.
7. Rendered track and route geometry ends at the render envelope; merely intersecting the envelope must not expose the remainder of a global line.
8. Boundary stations retain their global ID in every projection and are never duplicated to satisfy neighboring tiles.
9. An invalid edit rolls back only the new edit. It cannot delete or truncate pre-existing global infrastructure.
10. A native autosave resolves to the matching global checkpoint and projection revision; it cannot promote an older projection over newer global state.

## 3. Architecture and seam

Add one deep `NetworkProjection` module. `WorldTileRuntime` is its only production caller; tests exercise the same interface.

```ts
interface NetworkProjection {
  build(input: {
    network: GlobalNetwork;
    activeTileId: TileId;
    catalog: TileCatalog;
  }): ProjectionResult;

  reconcile(input: {
    network: GlobalNetwork;
    baseline: ProjectionManifest;
    nativeSnapshot: NativeSnapshot;
  }): ReconciliationResult;
}
```

`build` hides window selection, spatial indexing, boundary ownership, clipping, synthetic terminals, referential closure, route fragmentation, and native-save shaping. `reconcile` hides diffing, edit classification, conflict detection, rollback material, and global revision updates.

Do not add separate public modules for track clipping, boundary stations, route fragments, or edit validation. Those are internal seams of `NetworkProjection` and should be tested through the interface above.

The existing adapters remain:

- `SubwayBuilderGameAdapter` captures and restores native snapshots but does not decide which edits are legal.
- `ModStorageWorldStateAdapter` persists the authoritative world and exact save checkpoints.
- Fixture adapters provide deterministic in-memory snapshots for projection and crash-recovery tests.

## 4. Global network model

Add a versioned global network record to the world schema:

```ts
type GlobalNetwork = {
  schemaVersion: number;
  revision: number;
  stationsById: Record<StationId, GlobalStation>;
  tracksById: Record<TrackId, GlobalTrack>;
  routesById: Record<RouteId, GlobalRoute>;
  trainsById: Record<TrainId, GlobalTrain>;
  stationGroupsById: Record<StationGroupId, GlobalStationGroup>;
  signalsById: Record<SignalId, GlobalSignal>;
};

type GlobalRoute = {
  id: RouteId;
  revision: number;
  nativeFields: NativeRouteMetadata;
  orderedStationIds: StationId[];
  orderedSegmentIds: TrackId[];
  timetableSchedule: NativeTimetableSchedule | null;
  trainSchedule: NativeTrainSchedule | null;
  fullCycleTimeSeconds: number;
  departureAnchorsByNode: Record<StationId, number[]>;
};
```

Store native-compatible fields needed to reconstruct a complete route, but make station sequence, physical path, schedule, and cycle time explicit enough that projection fragments cannot accidentally redefine them.

The migration from the current prototype should extract the shared network once from the newest valid matching checkpoint, assign ownership from stable coordinates and IDs, and remove copied shared-network bodies from inactive tile snapshots only after the new global record commits successfully.

## 5. Projection construction

### 5.1 Window and ownership

- Select all addressable tiles within one grid step of the active tile, including diagonal neighbors.
- Use half-open ownership rectangles `[minX, maxX) × [minY, maxY)` for canonical ownership.
- Preserve catalog gaps and slivers as geometry; do not infer adjacency from array order.
- Build a spatial index for global stations and tracks keyed by projected bounds.

### 5.2 Stations

Include a station when any of these is true:

- its canonical point lies inside the render envelope;
- its platform geometry intersects the envelope;
- it is required by a retained visible track or route fragment;
- it lies in the guard band and is needed to terminate visible infrastructure coherently.

Boundary rules:

- Reuse the global station ID and native station fields.
- Never create a second real station at the same boundary.
- Mark guard-band-only stations as projection dependencies and non-editable.
- Reject deletion, relocation, grouping, or platform changes when unseen dependencies exist outside the window.
- On ambiguity or floating-point disagreement, preserve the station and report a diagnostic rather than deleting it.

### 5.3 Tracks and synthetic terminals

- Query tracks whose bounds intersect the render envelope.
- Clip each coordinate sequence to the envelope.
- Preserve complete in-window tracks unchanged.
- For crossing tracks, create deterministic projection-only terminal nodes at envelope intersections.
- Derive synthetic IDs from `(globalTrackId, projectionRevision, boundaryEdge, crossingIndex)`.
- Record the mapping from every projected object to its global source.
- Never write synthetic nodes, split IDs, or clipped coordinates into the global network.

### 5.4 Routes

Classify each route:

- **Fully contained:** every referenced station and track lies inside the editable window. Deliver it as an ordinary native route and permit native topology and schedule editing.
- **Partial:** the route crosses the outer projection boundary. Split it into contiguous visible fragments, preserve the source route ID in the projection manifest, and treat topology as read-only.
- **Outside:** no physical geometry intersects the window. Do not deliver it to native state.

Partial fragments retain route name, color, type, fare identity, and visible station membership for native rendering. Their clipped path and any synthetic terminals are presentation state, not a shortened global route.

### 5.5 Trains and signals

- Deliver trains only when their current physical window intersects a retained route fragment.
- Preserve the complete fleet allocation and schedule globally.
- Do not let a projected train crossing a synthetic terminal delete, finish, or reverse the global train.
- Include signals and track groups by referential closure from retained tracks.
- If the native simulator cannot safely host a partial-route train, omit that train from native state and show only a lightweight projected marker in a later milestone.

## 6. Route station lists and headways

The global route descriptor remains complete even when visible rail is clipped.

Fields that can be edited and merged from any projection:

- name and color;
- fare assignment;
- train type and cars per train, subject to global validation;
- explicit timetable periods and `headwaySeconds`;
- classic train-count schedules, subject to global fleet validation.

Fields that require the affected topology to be fully contained:

- station insertion, deletion, or reordering;
- route extension or shortening;
- path regeneration;
- direction reversal;
- conversion that rewrites referenced track types.

The base game derives frequency and fleet requirements from physical route cycle time. A partial fragment therefore must not use its clipped cycle time as authoritative. For partial routes:

1. Display the complete ordered station list and schedule in a mod-owned route-service section.
2. Calculate displayed frequency and fleet requirements from `fullCycleTimeSeconds`.
3. Merge schedule changes into the global route only.
4. Rebuild the current projection after a successful schedule change.
5. Mark cross-tile mode share dirty using the existing midnight invalidation policy.

The native schedule panel remains authoritative only for fully contained routes. If a native schedule hook fires for a partial fragment, capture the requested schedule fields, recompute against the global route, then replace the native fragment with a fresh projection so clipped geometry cannot influence persisted frequency.

## 7. Edit defense and user feedback

The public hooks mostly observe changes after they occur, so enforcement is checkpoint-and-rollback:

```text
native edit
    ↓
capture changed snapshot
    ↓
NetworkProjection.reconcile
    ├─ accepted → merge allowlisted fields into global network
    └─ rejected → restore baseline projection and clear related preview
```

Maintain a projection baseline hash and a hook-suppression token so restoration does not recursively trigger another reconciliation.

Reject an edit when it:

- creates geometry beyond the editable 3×3 ownership union;
- changes a projection-only terminal;
- mutates partial-route topology;
- removes a boundary station with unseen dependencies;
- produces unresolved station, track, route, train, signal, or group references;
- changes a global object from a stale projection revision.

Publish the rejection through `WorldTileRuntime.view()` as structured state:

```ts
type ProjectionWarning = {
  code: "outside-window" | "partial-route-locked" | "boundary-dependency" | "stale-projection";
  message: string;
  affectedObjectIds: string[];
  suggestedTileIds: TileId[];
};
```

The tile switcher should highlight the suggested tile or tiles and show one concise warning. Repeated hook events from the same rejected action must not create repeated notifications.

## 8. Transition and checkpoint integration

Replace `mergeSharedTransitNetwork(destinationSnapshot, sourceSnapshot)` in the transition path with:

1. Capture the active native snapshot.
2. Reconcile it against the active projection baseline.
3. Commit accepted changes to `world.globalNetwork`.
4. Store tile-local non-network state separately.
5. Build the destination projection from the committed global network.
6. Overlay authoritative wallet, clock, fares, and financial history.
7. Restore and verify the projected native snapshot.
8. Commit the transition and projection manifest atomically.

Checkpoint manifests must record:

- global network revision/hash;
- active tile ID;
- projection schema version and projection hash;
- exact native save identity;
- tile-local snapshot hashes;
- warnings or rejected edits resolved before commit.

Never persist a checkpoint while an edit rollback or projection rebuild is incomplete.

## 9. Implementation milestones

### P0 — Contracts and fixtures

- Add global-network, projection-manifest, and reconciliation-result fixtures.
- Add 3×3, edge, corner, catalog-gap, boundary-station, crossing-track, and multi-fragment route cases.
- Freeze the first projection schema before modifying live transition behavior.

Gate: pure fixtures conserve all global IDs and reproduce identical projection hashes deterministically.

### P1 — Pure projection builder

- Implement window selection, spatial queries, station inclusion, line clipping, synthetic terminals, dependency closure, and route classification.
- Keep it disconnected from live saves.

Gate: no projected ordinary station lies outside the permitted envelope; no projected line geometry exceeds it; the global input remains byte-for-byte unchanged.

### P2 — Reconciliation and edit policy

- Diff baseline and changed native snapshots by stable ID and revision.
- Implement the safe-field allowlist, partial-route topology lock, boundary-station defense, rollback result, and hook suppression.

Gate: randomized invalid edits cannot delete or truncate any pre-existing global object; valid edits round-trip through a rebuilt projection.

### P3 — Global route descriptors and schedules

- Extract complete station sequences, schedules, full cycle times, and departure anchors.
- Add the partial-route service section and global schedule calculation.
- Route schedule hooks through reconciliation rather than accepting clipped native calculations.

Gate: station order and every schedule field remain identical through 100 alternating tile projections; displayed partial-route frequency uses the full cycle time.

### P4 — Runtime and checkpoint integration

- Add `globalNetwork` and projection metadata to `world-model.js`.
- Replace shared-network copying in `world-tile-runtime.js`.
- Add projection capture/restore methods to `SubwayBuilderGameAdapter`.
- Add tile-switcher warning state and adjacent-tile highlighting.
- Migrate existing KC and NY pilot checkpoints without losing their shared network.

Gate: forced interruption at every transition phase recovers either the previous committed projection or the next one, never a mixed global/native state.

### P5 — Installed-game canary

- Start with the seven-tile New York corridor.
- Test a route fully inside one tile, a route crossing one boundary, and a route spanning more than three tiles.
- Exercise building, deletion, rename, schedule changes, train changes, manual saves, ten retained autosaves, reloads, and hot reload.
- Capture DOM station count, JS heap, frame-time percentiles, projection-build time, transition time, and rejected-edit latency.

Gate: native station count remains bounded by the 3×3 projection, p95 frame time does not grow when distant global stations are added, and valid schedule/ridership/revenue results match the unbounded baseline.

### P6 — Scale decision

- Run synthetic 400-, 1,000-, and 5,000-station global networks while keeping the same active 3×3 projection.
- Verify that renderer cost follows projected entity count rather than global entity count.
- Decide whether partial-route trains can remain native or require lightweight projected markers.

Gate: proceed statewide only if renderer and transition metrics stay within the existing New York capacity gates.

## 10. Test matrix

At minimum, automate these cases:

| Case | Expected result |
| --- | --- |
| Station exactly on a shared edge | One global ID; present in every required projection; canonical owner stable |
| Station within guard band only | Preserved as dependency; edit rejected |
| Track crosses one outer edge | Clipped once; deterministic synthetic terminal; global track unchanged |
| Track exits and re-enters window | Multiple ordered fragments; no geometry outside envelope |
| Route entirely inside 3×3 | Native topology and schedule edits accepted |
| Route spans four tiles | Visible fragments rendered; topology locked; complete global station list retained |
| Partial-route timetable edit | Global headway updated; fleet calculated from full cycle time |
| Partial-route station deletion | Rejected and rolled back; suggested adjacent tile highlighted |
| Switch after rejected edit | No rejected geometry appears in destination or global state |
| Older autosave load | Matching global revision restored; newer projection not mixed in |
| Cross-mode-share recalculation | Same global network signature and path results as unbounded baseline |
| 100 alternating switches | No ID drift, duplicate boundary stations, money drift, or time rewind |

## 11. Fallbacks

- If native save validation rejects synthetic route terminals, render partial routes through a custom read-only MapLibre line layer while keeping fully contained routes native.
- If native schedule hooks cannot be reconciled reliably for partial fragments, disable partial-route native scheduling and expose only the global mod-owned controls.
- If post-action rollback is visually disruptive, add a pre-emptive guard band that blocks construction before the cursor reaches the outer projection edge.
- Do not fall back to copying the entire global network into every tile; that restores the renderer scaling problem this plan is intended to remove.
