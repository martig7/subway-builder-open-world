import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SHARED_SERVER_VERSION = 'native-pmtiles-directory-v4';
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateRegistrations(registrations, port, dataRoot) {
  const ids = new Set();
  const worlds = new Set();
  for (const item of registrations) {
    if (item.schemaVersion !== 1 || !safeId.test(item.manifestId) || worlds.has(item.manifestId.toLowerCase())) throw new Error('Invalid or duplicate shared-server World registration');
    worlds.add(item.manifestId.toLowerCase());
    if (item.tileServerPort !== port || path.resolve(item.dataRoot).toLowerCase() !== path.resolve(dataRoot).toLowerCase()) throw new Error('Shared Worlds must use one port and data directory');
    for (const key of ['dataRoot', 'productRoot', 'managerPath', 'serverExecutablePath']) {
      if (typeof item[key] !== 'string' || !path.isAbsolute(item[key])) throw new Error(`Invalid shared-server ${key}`);
    }
    if (!Array.isArray(item.tileIds) || !item.tileIds.length) throw new Error('Shared World has no tiles');
    for (const id of item.tileIds) {
      if (!safeId.test(id) || ids.has(id)) throw new Error(`Conflicting shared tile registration: ${id}`);
      ids.add(id);
    }
  }
  return [...ids].sort();
}

async function readRegistrations(root) {
  const files = await readdir(root);
  const registrations = [];
  for (const file of files.filter(name => name.endsWith('.json')).sort()) {
    const entry = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    if (file !== `${entry.manifestId}.json`) throw new Error(`Invalid World registration filename: ${file}`);
    registrations.push(entry);
  }
  return registrations;
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Shared tile-server command failed (${code}): ${output}`)));
  });
}

export async function prepareSharedServer({ definition, selectedTiles, dataRoot, version, localAppData = process.env.LOCALAPPDATA }) {
  if (!localAppData) throw new Error('LOCALAPPDATA is required for the official shared tile server');
  const root = path.join(localAppData, 'metro-maker4', 'open-world-pmtiles');
  const stateRoot = path.join(root, 'state');
  const registryRoot = path.join(stateRoot, 'worlds');
  const registrations = await readRegistrations(registryRoot).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Install the official Open World manager before installing this shared-server consumer');
    throw error;
  });
  const port = definition.runtime.tileServerPort;
  validateRegistrations(registrations, port, dataRoot);
  let provider;
  for (const item of registrations) {
    if (path.basename(item.serverExecutablePath).toLowerCase() !== 'open-world-tile-server.exe') continue;
    try {
      await access(item.serverExecutablePath);
      await access(item.managerPath);
      provider = item;
      break;
    } catch {}
  }
  if (!provider) throw new Error('No installed official Open World manager/server is available');
  const serverVersion = await run(provider.serverExecutablePath, ['version']);
  if (!serverVersion.startsWith(`${SHARED_SERVER_VERSION} (`)) throw new Error(`Unexpected shared-server implementation: ${serverVersion}`);
  const registration = {
    schemaVersion: 1, manifestId: definition.identity.manifestId, version, tileServerPort: port,
    productRoot: provider.productRoot, managerPath: provider.managerPath,
    serverExecutablePath: provider.serverExecutablePath, dataRoot: path.resolve(dataRoot),
    tileIds: selectedTiles.map(tile => tile.id),
  };
  validateRegistrations([...registrations.filter(item => item.manifestId !== registration.manifestId), registration], port, dataRoot);
  return { root, stateRoot, registryRoot, port, registration };
}

export async function stopSharedServer(context) {
  // The official executable verifies managed state, executable identity,
  // start time and the instance token before requesting shutdown. No PID kills.
  await run(context.registration.serverExecutablePath, ['stop', '--port', String(context.port), '--state-root', context.stateRoot]);
}

export async function registerSharedWorld(context) {
  const { registryRoot, registration, port } = context;
  const current = await readRegistrations(registryRoot);
  validateRegistrations([...current.filter(item => item.manifestId !== registration.manifestId), registration], port, registration.dataRoot);
  await mkdir(registryRoot, { recursive: true });
  const destination = path.join(registryRoot, `${registration.manifestId}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registration, null, 2)}\n`);
  await rename(temporary, destination);
}

export async function startSharedServer(context, definition) {
  const registrations = await readRegistrations(context.registryRoot);
  const tileIds = validateRegistrations(registrations, context.port, context.registration.dataRoot);
  const child = spawn(context.registration.serverExecutablePath, [
    'serve', '--root', context.registration.dataRoot, '--port', String(context.port),
    '--state-root', context.stateRoot, '--log-root', path.join(context.root, 'logs'),
    '--tiles', tileIds.join(','),
  ], { windowsHide: true, detached: true, stdio: 'ignore' });
  let failure;
  child.once('error', error => { failure = error; });
  child.unref();
  const baseUrl = `http://127.0.0.1:${context.port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (failure) throw failure;
    try {
      const response = await fetch(`${baseUrl}/_health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && response.headers.get('x-pmtiles-server-version') === SHARED_SERVER_VERSION) {
        const health = await response.json();
        if (path.resolve(health.root).toLowerCase() !== path.resolve(context.registration.dataRoot).toLowerCase()) throw new Error('Shared server has the wrong data directory');
        if (JSON.stringify([...health.tileIds].sort()) === JSON.stringify(tileIds)) {
          const tile = await fetch(`${baseUrl}/${definition.runtime.healthTile}`, { signal: AbortSignal.timeout(5000) });
          if (tile.ok && (await tile.arrayBuffer()).byteLength > 0) return { status: 'shared-native-running', baseUrl, tileCount: tileIds.length };
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Official shared server failed its World-union or Japan tile health check');
}
