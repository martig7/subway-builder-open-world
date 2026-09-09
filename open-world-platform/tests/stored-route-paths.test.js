import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenWorldRoutePaths } from '../src/runtime/route-path-controller.js';
import { createStoredRoutePaths, decodePolyline6 } from '../src/runtime/stored-route-paths.js';

const record = { origin: [0, 0], destination: [.000001, .000001], polyline: '??AA', source: 'stored-osrm' };
test('native and cross route views use stored geometry without creating a road worker', async () => {
  const calls = [];
  const paths = createOpenWorldRoutePaths({ tileCatalog: { tiles: [{ id: 'a' }] }, nativePopPrefixes: ['local-'], crossPopPrefixes: ['cross-'],
    storedRouteLoader: async request => { calls.push(request); return record; },
    workerOptions: { WorkerClass: class { constructor() { throw new Error('Must not build a graph'); } } } });
  assert.deepEqual((await paths.resolve('a', 'local-1')).coordinates, [[0, 0], [.000001, .000001]]);
  await paths.resolve('a', 'cross-1');
  assert.deepEqual(calls.map(c => c.kind), ['native', 'cross']);
  assert.equal(paths.diagnostics().version, 'stored-driving-routes-v1');
  paths.dispose();
});
test('stored routes coalesce requests, bound cached records, and decode fresh coordinates', async () => {
  let calls = 0;
  const paths = createStoredRoutePaths({ owns: () => true, kind: () => 'native', cacheLimitBytes: 600,
    loadRecord: async () => { calls++; return record; } });
  const [a, b] = await Promise.all([paths.resolve('a', '1'), paths.resolve('a', '1')]);
  assert.equal(calls, 1);
  a.coordinates[0][0] = 50;
  assert.equal(b.coordinates[0][0], 0);
  for (let i = 2; i < 20; i++) await paths.resolve('a', String(i));
  assert.ok(paths.diagnostics().cacheBytes <= 600);
  assert.ok(paths.diagnostics().cacheEntries < 19);
  paths.dispose();
  assert.equal(paths.diagnostics().cacheBytes, 0);
});
test('bad polyline data is rejected and failed requests can be retried', async () => {
  assert.throws(() => decodePolyline6('~'), /polyline/i);
  let calls = 0;
  const paths = createStoredRoutePaths({ owns: () => true, kind: () => 'cross', loadRecord: async () => {
    if (++calls === 1) throw new Error('temporary read failure'); return record;
  } });
  assert.equal(await paths.resolve('a', '1'), null);
  assert.equal((await paths.resolve('a', '1')).source, 'stored-osrm');
  assert.equal(calls, 2);
});
test('disposing an old route session aborts its request and never repopulates its cache', async () => {
  let signal, finish;
  const paths = createStoredRoutePaths({ owns: () => true, kind: () => 'native', loadRecord: request => {
    signal = request.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const request = paths.resolve('a', '1');
  await Promise.resolve();
  paths.dispose();
  assert.equal(signal.aborted, true);
  finish(record);
  assert.equal(await request, null);
  assert.equal(paths.diagnostics().cacheEntries, 0);
});
