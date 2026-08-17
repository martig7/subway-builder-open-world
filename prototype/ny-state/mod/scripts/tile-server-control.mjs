import { spawnSync } from 'node:child_process';

export const DEFAULT_TILE_SERVER_BASE = 'http://127.0.0.1:8798';
export const NATIVE_PMTILES_SERVER_VERSION = 'native-pmtiles-directory-v2';
const HEALTH_TILE = 'NY_CP00_RP00/2/2/2.mvt?v=world-z0-z9-v2';

export function tileServerHealthUrl(baseUrl = DEFAULT_TILE_SERVER_BASE) {
  return `${String(baseUrl).replace(/\/$/, '')}/${HEALTH_TILE}`;
}

async function probeTileServer(fetchImpl, baseUrl) {
  try {
    const response = await fetchImpl(tileServerHealthUrl(baseUrl), { cache: 'no-store' });
    if (!response?.ok) return false;
    if (response.headers?.get?.('x-pmtiles-server-version') !== NATIVE_PMTILES_SERVER_VERSION) return false;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && new Uint8Array(bytes)[0] === 0x1a;
  } catch {
    return false;
  }
}

export async function ensureTileServerReady({
  platform = process.platform,
  starterPath,
  baseUrl = DEFAULT_TILE_SERVER_BASE,
  fetchImpl = globalThis.fetch,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Tile-server readiness requires fetch');
  if (await probeTileServer(fetchImpl, baseUrl)) return { status: 'already-running', baseUrl };
  if (platform !== 'win32') {
    throw new Error(`PMTiles server is unavailable at ${baseUrl}; start the platform-specific tile service first`);
  }
  if (!starterPath) throw new Error('PMTiles server starter path is required');

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starterPath];
  const started = spawnSyncImpl('powershell.exe', args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (started?.error) throw started.error;
  if (started?.status !== 0) throw new Error(`PMTiles server starter exited with code ${started?.status ?? 'unknown'}`);
  if (!(await probeTileServer(fetchImpl, baseUrl))) {
    throw new Error(`PMTiles server started but the vector-tile health check still fails: ${tileServerHealthUrl(baseUrl)}`);
  }
  return { status: 'started', baseUrl };
}
