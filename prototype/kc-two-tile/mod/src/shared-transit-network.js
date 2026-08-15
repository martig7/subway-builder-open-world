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

/** Copy only the player-built transit network while retaining tile-local save data. */
export function mergeSharedTransitNetworkState(destinationState, sourceState) {
  const merged = structuredClone(destinationState ?? {});
  for (const key of SHARED_TRANSIT_STATE_KEYS) {
    if (sourceState?.[key] !== undefined) merged[key] = structuredClone(sourceState[key]);
  }
  return merged;
}
