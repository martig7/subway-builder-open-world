import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORLD_IDENTITY_ALIAS_PREFIX } from '../../../../open-world-platform/src/runtime/world-identity.js';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

const sessionId = option('session');
const worldId = option('world');
if (!sessionId || !worldId) throw new Error('--session and --world are required');
const input = path.resolve(option('input') ?? path.join(
  process.env.APPDATA ?? '', 'metro-maker4', 'mod-data', 'local.ny-state-six-tile-canary.json',
));
const store = JSON.parse(await readFile(input, 'utf8'));
if (!store[`world:${worldId}`]?.globalNetwork) throw new Error(`Target world does not exist: ${worldId}`);
const key = `${WORLD_IDENTITY_ALIAS_PREFIX}${sessionId}`;
store[key] = worldId;
const backup = `${input}.pre-session-binding-${Date.now()}.bak`;
await copyFile(input, backup);
await writeFile(input, JSON.stringify(store));
console.log(JSON.stringify({ input, key, worldId, backup }, null, 2));
