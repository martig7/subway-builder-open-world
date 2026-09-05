// Subway Builder 1.7 stores this opt-in feature in localStorage, separately
// from saves and PATHFINDING_RULES. Never infer today's setting from saved paths.
export function readDriveToStationAccess(storage) {
  try {
    const flags = JSON.parse((storage ?? globalThis.localStorage)?.getItem('featureFlags') ?? '{}');
    return flags?.DRIVE_TO_STATION_ACCESS === true;
  } catch {
    return false;
  }
}
