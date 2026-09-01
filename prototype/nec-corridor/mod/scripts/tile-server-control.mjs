import { spawn } from 'node:child_process';

export const DEFAULT_TILE_SERVER_BASE = 'http://127.0.0.1:8799';
export const NATIVE_PMTILES_SERVER_VERSION = 'native-pmtiles-directory-v2';
const HEALTH_TILE = 'NEC_CP00_RP00/0/0/0.mvt?v=nec-corridor-z0-z9-v2';

export function tileServerHealthUrl(baseUrl = DEFAULT_TILE_SERVER_BASE) {
  return `${String(baseUrl).replace(/\/$/, '')}/${HEALTH_TILE}`;
}

export async function stopTileServer({
  platform = process.platform,
  starterPath,
  installRoot,
  spawnImpl = spawn,
} = {}) {
  if (platform !== 'win32') return { status: 'not-supported' };
  if (!starterPath) throw new Error('Tile-server starter path is required');
  if (!installRoot) throw new Error('Installed mod path is required to verify the tile-server process');
  await new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      starterPath,
      '-Stop',
      '-ExpectedInstallRoot',
      installRoot,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PMTiles server stop exited with code ${code}`));
    });
  });
  return { status: 'stopped' };
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
  spawnImpl = spawn,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Tile-server readiness requires fetch');
  if (await probeTileServer(fetchImpl, baseUrl)) return { status: 'already-running', baseUrl };
  if (platform !== 'win32') {
    throw new Error(`PMTiles server is unavailable at ${baseUrl}; start the platform-specific tile service first`);
  }
  if (!starterPath) throw new Error('Tile-server starter path is required');
  await new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starterPath, '-Background'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PMTiles server starter exited with code ${code}`));
    });
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await probeTileServer(fetchImpl, baseUrl)) return { status: 'started', baseUrl };
  }
  throw new Error(`PMTiles server started but the vector-tile health check still fails: ${tileServerHealthUrl(baseUrl)}`);
}
