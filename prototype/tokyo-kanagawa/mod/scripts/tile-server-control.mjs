import { spawn } from 'node:child_process';

export const DEFAULT_TILE_SERVER_BASE = 'http://127.0.0.1:8800';
export const NATIVE_PMTILES_SERVER_VERSION = 'native-pmtiles-directory-v2';
// The map package is geographically clipped, so z0/0/0 is intentionally
// absent. Probe a known Tokyo tile to validate both the server and archive.
const HEALTH_TILE = 'JP_TOKYO_MAINLAND/8/227/100.mvt?v=tokyo-kanagawa-mainland-v2';

export function tileServerHealthUrl(baseUrl = DEFAULT_TILE_SERVER_BASE) {
  return `${String(baseUrl).replace(/\/$/, '')}/${HEALTH_TILE}`;
}

export async function stopTileServer({
  platform = process.platform,
  starterPath,
  spawnImpl = spawn,
} = {}) {
  if (platform !== 'win32') return { status: 'not-managed', platform };
  if (!starterPath) throw new Error('Tile-server starter path is required');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starterPath, '-Stop'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`PMTiles server stop command exited with code ${exitCode}`);
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
  const starterExitCode = await new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starterPath, '-Background'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  if (starterExitCode !== 0) {
    throw new Error(`PMTiles server starter exited with code ${starterExitCode}`);
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await probeTileServer(fetchImpl, baseUrl)) return { status: 'started', baseUrl };
  }
  throw new Error(`PMTiles server started but the vector-tile health check still fails: ${tileServerHealthUrl(baseUrl)}`);
}
