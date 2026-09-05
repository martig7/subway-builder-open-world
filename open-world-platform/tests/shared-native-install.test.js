import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateRegistrations, SHARED_SERVER_VERSION } from '../src/installer/shared-tile-server-control.js';

const dataRoot = path.resolve('test-city-data');
const registration = (manifestId, tileIds) => ({
  schemaVersion: 1, manifestId, version: '0.5.0', tileServerPort: 8799,
  productRoot: path.resolve('test-manager'), managerPath: path.resolve('test-manager/manager.exe'),
  serverExecutablePath: path.resolve('test-manager/server/open-world-tile-server.exe'), dataRoot, tileIds,
});

test('shared registry preserves NEC and adds Japan to the same server union', () => {
  const nec = registration('northeast-corridor-open-world', ['NEC_CP00_RP00']);
  const japan = registration('local.japan-open-world', ['JP_PREF_27', 'JP_TOKYO_MAINLAND']);
  const before = structuredClone(nec);
  assert.deepEqual(validateRegistrations([nec, japan], 8799, dataRoot), ['JP_PREF_27', 'JP_TOKYO_MAINLAND', 'NEC_CP00_RP00']);
  assert.deepEqual(nec, before);
  assert.equal(SHARED_SERVER_VERSION, 'native-pmtiles-directory-v4');
});

test('shared registry rejects overlapping ownership, ports, roots and unsafe IDs', () => {
  const first = registration('world-a', ['JP_TOKYO_MAINLAND']);
  assert.throws(() => validateRegistrations([first, registration('world-b', ['JP_TOKYO_MAINLAND'])], 8799, dataRoot), /Conflicting/);
  for (const changes of [{ tileServerPort: 8801 }, { dataRoot: path.resolve('other-data') }, { tileIds: ['../outside'] }, { managerPath: 'relative.exe' }]) {
    assert.throws(() => validateRegistrations([{ ...first, ...changes }], 8799, dataRoot));
  }
});

test('Japan release integration preserves LOD, selection and label inputs', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const world = JSON.parse(await readFile(path.join(root, 'worlds/japan/world.json')));
  assert.equal(world.runtime.tileServerPort, 8799);
  assert.equal(world.runtime.tileServerProvider, 'shared-native-v4');
  assert.equal(world.identity.author, 'Giancarlo Martinelli (gcm)');
  assert.equal(world.identity.manifestId, 'local.japan-open-world');
  assert.equal(world.map.labelPolicy, 'japan-source-romaji-v1');
  assert.equal(world.tileViews.boundaryOverlay, 'geography/display-boundaries.json');
  const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
