import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateRegistrations, SHARED_SERVER_VERSION, startSharedServer } from '../src/installer/shared-tile-server-control.js';

const dataRoot = path.resolve('test-city-data');
const registration = (manifestId, tileIds) => ({
  schemaVersion: 1, manifestId, version: '0.5.0', tileServerPort: 8799,
  productRoot: path.resolve('test-manager'), managerPath: path.resolve('test-manager/manager.exe'),
  serverExecutablePath: path.resolve('test-manager/server/open-world-tile-server.exe'), dataRoot, tileIds,
});

async function registryFixture(t, tileIds) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-server-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = registration('local.test-world', tileIds);
  await writeFile(path.join(root, `${world.manifestId}.json`), JSON.stringify(world));
  return { root, stateRoot: root, registryRoot: root, registration: world, port: 8799 };
}

for (const [change, previousIds, selectedIds] of [
  ['adding already installed tiles', ['TEST_TILE'], ['TEST_TILE', 'OTHER_TILE']],
  ['removing tiles', ['TEST_TILE', 'OTHER_TILE'], ['TEST_TILE']],
]) {
  test(`a changed shared registry union stops the verified server before ${change}`, async t => {
    const context = await registryFixture(t, selectedIds);
    const calls = [];
    let liveIds = previousIds;
    const result = await startSharedServer(context, { runtime: { healthTile: 'TEST_TILE/0/0/0.mvt' } }, {
      async stopImpl(stopped) { assert.equal(stopped, context); calls.push('verified-stop'); },
      spawnImpl(_executable, args) {
        assert.deepEqual(calls, ['verified-stop']);
        assert.equal(args[args.indexOf('--tiles') + 1], [...selectedIds].sort().join(','));
        calls.push('serve');
        liveIds = selectedIds;
        return { once() {}, unref() {} };
      },
      async fetchImpl(url) {
        return url.endsWith('/_health')
          ? { ok: true, headers: new Headers({ 'x-pmtiles-server-version': SHARED_SERVER_VERSION }), json: async () => ({ root: dataRoot, tileIds: liveIds }) }
          : { ok: true, arrayBuffer: async () => new Uint8Array([0x1a]).buffer };
      },
    });
    assert.equal(result.status, 'shared-native-running');
    assert.deepEqual(calls, ['verified-stop', 'serve']);
  });
}

test('a failed managed-instance verification prevents a competing server from spawning', async t => {
  const context = await registryFixture(t, ['TEST_TILE', 'OTHER_TILE']);
  await assert.rejects(startSharedServer(context, { runtime: { healthTile: 'TEST_TILE/0/0/0.mvt' } }, {
    async stopImpl() { throw new Error('Refusing to stop: managed instance token mismatch'); },
    spawnImpl() { assert.fail('failed verification must prevent startup'); },
    async fetchImpl() {
      return { ok: true, headers: new Headers({ 'x-pmtiles-server-version': SHARED_SERVER_VERSION }), json: async () => ({ root: dataRoot, tileIds: ['TEST_TILE'] }) };
    },
  }), /managed instance token mismatch/);
});

test('a service with another version or data root is neither stopped nor replaced', async t => {
  const context = await registryFixture(t, ['TEST_TILE']);
  for (const [version, root] of [['foreign-service', dataRoot], [SHARED_SERVER_VERSION, path.resolve('foreign-data')]]) {
    await assert.rejects(startSharedServer(context, { runtime: { healthTile: 'TEST_TILE/0/0/0.mvt' } }, {
      async stopImpl() { assert.fail('unknown services must not be stopped'); },
      spawnImpl() { assert.fail('unknown services must not be replaced'); },
      async fetchImpl() {
        return { ok: true, headers: new Headers({ 'x-pmtiles-server-version': version }), json: async () => ({ root, tileIds: ['TEST_TILE'] }) };
      },
    }), /Refusing to start a competing tile server/);
  }
});

test('a healthy shared server is reused without spawning a competing process', async t => {
  const registryRoot = await mkdtemp(path.join(os.tmpdir(), 'open-world-server-registry-'));
  t.after(() => rm(registryRoot, { recursive: true, force: true }));
  const world = registration('local.test-world', ['TEST_TILE']);
  await writeFile(path.join(registryRoot, `${world.manifestId}.json`), JSON.stringify(world));
  const result = await startSharedServer({ registryRoot, registration: world, port: 8799 }, { runtime: { healthTile: 'TEST_TILE/0/0/0.mvt' } }, {
    spawnImpl() { assert.fail('a healthy server must not be restarted'); },
    async fetchImpl(url) {
      return url.endsWith('/_health')
        ? { ok: true, headers: new Headers({ 'x-pmtiles-server-version': SHARED_SERVER_VERSION }), json: async () => ({ root: dataRoot, tileIds: ['TEST_TILE'] }) }
        : { ok: true, arrayBuffer: async () => new Uint8Array([0x1a]).buffer };
    },
  });
  assert.equal(result.status, 'shared-native-running');
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
  assert.equal(world.map.labelPolicy, 'japan-source-romaji-v2');
  assert.equal(world.tileViews.boundaryOverlay, 'geography/display-boundaries.json');
  const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
