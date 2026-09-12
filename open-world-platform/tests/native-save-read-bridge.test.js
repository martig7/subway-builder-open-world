import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installNativeSaveReadBridge } from '../src/host/native-save-read-bridge.js';

function harness(read) {
  const context = vm.createContext({});
  const crossed = [];
  const contextBridge = {
    exposeInMainWorld(key, api) {
      context[key] = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name,
        typeof fn === 'function' ? async (...args) => { const result = await fn(...args); crossed.push({ name, result }); return result; } : fn]));
    },
    executeInMainWorld({ func, args }) {
      context.args = args;
      return vm.runInContext(`(${func.toString()})(...args)`, context);
    },
  };
  const originalExpose = contextBridge.exposeInMainWorld;
  installNativeSaveReadBridge(contextBridge);
  contextBridge.exposeInMainWorld('unrelated', { value: 42 });
  contextBridge.exposeInMainWorld('electron', { getPendingSave: read, untouched: () => 'native' });
  return { api: context.electron, context, crossed, contextBridge, originalExpose };
}

test('large pending save crosses as text and restores every native value', async () => {
  const data = { success: true, data: { name: 'latest', cityCode: 'JP_KANAGAWA_MAINLAND',
    gameSessionId: 'native-session', data: { money: 19174020261240.25, timeConfig: { paused: true, elapsedSeconds: 215890461 },
      compressedDemandData: { c: Array.from({ length: 20000 }, (_, i) => ({ p: `pop-${i}`, s: i, sr: [{ routeId: 'route', stationIds: ['a', 'b'] }] })) } } } };
  const before = structuredClone(data);
  const h = harness(async () => data);
  const actual = await h.api.getPendingSave();
  assert.equal(typeof h.crossed[0].result.text, 'string', 'native bridge must receive one string instead of the nested save graph');
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), before);
  assert.deepEqual(data, before, 'encoding never edits native save authority');
  assert.equal(await h.api.untouched(), 'native');
  assert.equal(h.contextBridge.exposeInMainWorld, h.originalExpose);
  assert.equal(Object.getOwnPropertyDescriptor(h.context, 'electron').writable, false);
  assert.equal(Object.isFrozen(h.api), true);
});

test('identity reads exclude topology, finances and commuter history', async () => {
  const h = harness(async () => ({ success: true, data: { id: 'save.metro', name: 'save',
    gameSessionId: 'session', cityCode: 'JP_A', timestamp: 12,
    metadata: { openWorldNativeRecovery: { schemaVersion: 1, recoveryId: 'r', reason: 'renderer-reload' } },
    data: { routes: [1], money: 50, compressedDemandData: { c: [1] } } } }));
  const result = await h.api.__openWorldGetPendingSaveInfo();
  assert.equal(result.data.id, 'save.metro');
  assert.equal(result.data.gameSessionId, 'session');
  assert.equal(result.data.metadata.openWorldNativeRecovery.recoveryId, 'r');
  assert.equal(Object.hasOwn(result.data, 'data'), false);
});

test('non-JSON values and shared references retain the native transfer semantics', async () => {
  const shared = { station: 'a' };
  const values = [2n, new Date(), new Map([['a', 1]]), { a: shared, b: shared }, new Array(2)];
  const circular = {}; circular.self = circular; values.push(circular);
  for (const data of values) {
    const h = harness(async () => data);
    assert.equal(await h.api.getPendingSave(), data);
    assert.equal(h.crossed[0].result.format, 'native');
  }
});

test('optional native fields and special numbers survive JSON transport exactly', async () => {
  for (const input of [undefined, NaN, Infinity, -Infinity, -0,
    { routeThumbnail: undefined, nested: [undefined, -0, NaN, Infinity, -Infinity] },
    Object.defineProperty({}, '__proto__', { value: undefined, enumerable: true })]) {
    const h = harness(async () => input);
    const actual = await h.api.getPendingSave();
    assert.equal(h.crossed[0].result.format, 'json');
    if (input && typeof input === 'object') {
      assert.deepEqual(structuredClone(actual), structuredClone(input));
    } else assert.ok(Object.is(actual, input));
  }
});

test('errors, empty pending saves and concurrent reads keep their native results', async () => {
  let count = 0;
  const h = harness(async () => {
    if (++count === 1) throw new Error('read failed');
    return { success: true, data: null, count };
  });
  await assert.rejects(h.api.getPendingSave(), /read failed/);
  const results = await Promise.all([h.api.getPendingSave(), h.api.getPendingSave()]);
  assert.deepEqual(results.map(r => r.count), [2, 3]);
  assert.ok(results.every(r => r.data === null));
});

test('unsupported hosts expose their original API', () => {
  let actual;
  const bridge = { exposeInMainWorld: (_key, api) => { actual = api; } };
  const native = { getPendingSave() {} };
  installNativeSaveReadBridge(bridge);
  bridge.exposeInMainWorld('electron', native);
  assert.equal(actual, native);
});
