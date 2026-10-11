export const MANAGER_STATION_NAMING_VERSION = 'manager-station-naming-v1';
export const MANAGER_STATION_NAMING_BATCH_SIZE = 32;

/** Read the game's saved naming choice without loading a road package. */
export async function readNativeStationNamingScheme(bridge = globalThis.electron) {
  if (typeof bridge?.getSetting !== 'function') return 'cross-street';
  const result = await bridge.getSetting('stationNamingScheme');
  return result?.success && result.value === 'intersection' ? 'intersection' : 'cross-street';
}

function tilesNearStations(tileCatalog, stations) {
  return (tileCatalog?.tiles ?? []).filter(tile => {
    const bounds = tile.haloBounds ?? tile.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return true;
    return stations.some(({ point: [x, y] }) => bounds[0] <= x + .01 && bounds[2] >= x - .01
      && bounds[1] <= y + .01 && bounds[3] >= y - .01);
  }).map(tile => tile.gameCityCode ?? tile.id);
}

/** Compact requests only. The manager reads its installed roads directly from disk. */
export function createManagerStationNaming({ processing, tileCatalog,
  getNamingScheme = readNativeStationNamingScheme, requestId = () => globalThis.crypto.randomUUID() } = {}) {
  return {
    async resolve({ stations, contextKey, signal, isCurrent = () => true }) {
      if (!processing || !(await processing.settings({ fresh: true })).stationNamingEnabled) return null;
      const names = [];
      const namingScheme = await getNamingScheme();
      const context = String(contextKey ?? 'native');
      for (let offset = 0; offset < stations.length; offset += MANAGER_STATION_NAMING_BATCH_SIZE) {
        signal?.throwIfAborted?.();
        if (!isCurrent()) return null;
        const batch = stations.slice(offset, offset + MANAGER_STATION_NAMING_BATCH_SIZE);
        const id = requestId();
        const result = await processing.request('/_processing/station-names', {
          version: MANAGER_STATION_NAMING_VERSION, requestId: id, contextKey: context,
          tileIds: tilesNearStations(tileCatalog, batch), stations: batch, namingScheme,
        }, { signal });
        signal?.throwIfAborted?.();
        if (!isCurrent()) return null;
        if (result?.version !== MANAGER_STATION_NAMING_VERSION || result.requestId !== id || result.contextKey !== context
          || !Array.isArray(result.names) || result.names.length !== batch.length) throw new Error('Manager returned a stale station naming response.');
        const expected = new Set(batch.map(station => station.id));
        for (const value of result.names) {
          if (!expected.delete(value?.id) || (value.name !== null && (typeof value.name !== 'string' || value.name.length > 1024)))
            throw new Error('Manager returned invalid station names.');
          names.push({ id: value.id, name: value.name });
        }
      }
      return names;
    },
  };
}
