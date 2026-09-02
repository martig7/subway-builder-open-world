export const SHARED_TRANSIT_STATE_KEYS = Object.freeze([
  'tracks',
  'trains',
  'routes',
  'trackGroups',
  'signals',
  'stNodes',
  'stations',
  'stationGroups',
  'fareGroups',
  'routeFinancials',
  'ownedTrainCount',
  'ownedCarsByType',
]);

/**
 * Native network lifecycle modes are intentionally explicit.  The old
 * projection path used a 3x3 facade as if it were a save payload; the
 * canonical mode keeps the complete player-built topology in every native
 * restore/save boundary and treats geographic windowing as presentation.
 */
export const NATIVE_NETWORK_LIFECYCLE_MODES = Object.freeze({
  CANONICAL: 'canonical-native',
  LEGACY_PROJECTION: 'legacy-projection',
});

export const CANONICAL_NATIVE_NETWORK_MODE = NATIVE_NETWORK_LIFECYCLE_MODES.CANONICAL;

export function isCanonicalNativeNetworkMode(mode) {
  return mode === CANONICAL_NATIVE_NETWORK_MODE;
}

/** The fields which must travel with a complete native topology snapshot. */
export const NATIVE_TOPOLOGY_STATE_KEYS = Object.freeze([...SHARED_TRANSIT_STATE_KEYS]);

export function hasCompleteNativeTopology(state) {
  return Boolean(state && NATIVE_TOPOLOGY_STATE_KEYS.every((key) => Object.hasOwn(state, key)));
}

/** Copy only the player-built transit network while retaining tile-local save data. */
export function mergeSharedTransitNetworkState(destinationState, sourceState) {
  const merged = structuredClone(destinationState ?? {});
  for (const key of SHARED_TRANSIT_STATE_KEYS) {
    if (sourceState?.[key] !== undefined) merged[key] = structuredClone(sourceState[key]);
  }
  return merged;
}
