import { spawn } from 'node:child_process';

export const NATIVE_PMTILES_SERVER_VERSION = 'native-pmtiles-directory-v2';

export function tileServerBaseUrl(definition) {
  return `http://127.0.0.1:${definition.runtime.tileServerPort}`;
}

export function tileServerHealthUrl(definition, baseUrl = tileServerBaseUrl(definition)) {
  return `${String(baseUrl).replace(/\/$/, '')}/${definition.runtime.healthTile}`;
}

async function runPowerShell(args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell exited with code ${code}`)));
  });
}

export async function stopTileServer({ definition, starterPath, installRoot, platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'win32') return { status: 'not-supported' };
  if (!definition || !starterPath || !installRoot) throw new Error('Stopping a tile server requires its definition, starter, and verified install root');
  await runPowerShell(['-File', starterPath, '-Port', String(definition.runtime.tileServerPort), '-Stop', '-ExpectedInstallRoot', installRoot], { spawnImpl });
  return { status: 'stopped' };
}

async function probe(definition, fetchImpl, baseUrl) {
  try {
    const response = await fetchImpl(tileServerHealthUrl(definition, baseUrl), { cache: 'no-store' });
    if (!response?.ok || response.headers?.get?.('x-pmtiles-server-version') !== NATIVE_PMTILES_SERVER_VERSION) return false;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && new Uint8Array(bytes)[0] === 0x1a;
  } catch { return false; }
}

export async function ensureTileServerReady({ definition, starterPath, platform = process.platform, fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
  if (!definition || typeof fetchImpl !== 'function') throw new Error('Tile-server readiness requires a definition and fetch');
  const baseUrl = tileServerBaseUrl(definition);
  if (await probe(definition, fetchImpl, baseUrl)) return { status: 'already-running', baseUrl };
  if (platform !== 'win32') throw new Error(`PMTiles server is unavailable at ${baseUrl}`);
  await runPowerShell(['-File', starterPath, '-Port', String(definition.runtime.tileServerPort), '-Background'], { spawnImpl });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await probe(definition, fetchImpl, baseUrl)) return { status: 'started', baseUrl };
  }
  throw new Error(`PMTiles server started but failed its verified tile probe: ${tileServerHealthUrl(definition, baseUrl)}`);
}
