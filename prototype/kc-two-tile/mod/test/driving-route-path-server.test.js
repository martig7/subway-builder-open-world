import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drivingRoutePathFetchGeneration,
  installDrivingRoutePathFetch,
  parseDrivingRoutePathRequest,
} from '../../../../open-world-platform/src/runtime/driving-route-path-server.js';

const coordinates = [[-75, 40], [-74.9, 40.1]];

test('driving route path parser accepts encoded native and cross-pop ids only on the map endpoint', () => {
  assert.deepEqual(parseDrivingRoutePathRequest('map://paths/NEC_A/nec-native-pop-1'), {
    city: 'NEC_A', popId: 'nec-native-pop-1',
  });
  assert.deepEqual(parseDrivingRoutePathRequest('map://paths/NEC_A/nec-cross-pop-%C3%A9'), {
    city: 'NEC_A', popId: 'nec-cross-pop-é',
  });
  assert.equal(parseDrivingRoutePathRequest('map://tiles/NEC_A/1'), null);
  assert.equal(parseDrivingRoutePathRequest('map://paths/NEC_A/a/extra'), null);
});

test('owned requests use the async resolver while unrelated requests pass through', async () => {
  const calls = [];
  const host = { fetch: async (input) => { calls.push(input); return new Response('native'); } };
  installDrivingRoutePathFetch(host, {
    owns: (city, popId) => city === 'NEC_A' && popId.startsWith('nec-'),
    resolve: async () => coordinates,
  });
  const routed = await host.fetch('map://paths/NEC_A/nec-native-pop-1');
  assert.deepEqual((await routed.json()).coordinates, coordinates);
  assert.deepEqual(calls, [], 'known-missing game endpoint must not be probed');
  assert.equal(await (await host.fetch('https://example.test/tile')).text(), 'native');
  assert.deepEqual(calls, ['https://example.test/tile']);
});

test('resolver misses and errors produce the quiet native 404 fallback', async () => {
  for (const resolve of [async () => null, async () => { throw new Error('routing failed'); }]) {
    const host = { fetch: async () => new Response('native') };
    installDrivingRoutePathFetch(host, { owns: () => true, resolve });
    const response = await host.fetch('map://paths/NEC_A/nec-native-pop-1');
    assert.equal(response.status, 404);
  }
});

test('same-generation reload swaps providers without stacking wrappers', async () => {
  const original = async () => new Response('', { status: 404 });
  const host = { fetch: original };
  const disposeOld = installDrivingRoutePathFetch(host, { owns: () => true, resolve: async () => coordinates });
  const wrapper = host.fetch;
  const replacement = [[1, 2], [3, 4]];
  const disposeNew = installDrivingRoutePathFetch(host, { owns: () => true, resolve: async () => replacement });
  assert.equal(host.fetch, wrapper);
  assert.deepEqual((await (await host.fetch('map://paths/NEC_A/nec-native-pop-1')).json()).coordinates, replacement);
  disposeOld();
  assert.equal(host.fetch, wrapper, 'stale generation cleanup must not remove the current provider');
  disposeNew();
  assert.equal(host.fetch, original);
});

test('attachment replaces a retained previous-generation patch and wrapper', async () => {
  const original = async () => new Response('original');
  const previousWrapper = async () => new Response('stale');
  const previousPatch = { generation: drivingRoutePathFetchGeneration - 1, original, wrapper: previousWrapper };
  Object.defineProperty(previousWrapper, '__openWorldDrivingRoutePathPatch__', { value: previousPatch });
  const host = { fetch: previousWrapper };
  installDrivingRoutePathFetch(host, { owns: () => false, resolve: async () => coordinates });
  assert.notEqual(host.fetch, previousWrapper, 'new generation must replace the retained wrapper closure');
  assert.notEqual(host.fetch.__openWorldDrivingRoutePathPatch__, previousPatch, 'new generation must replace the patch object');
  assert.equal(await (await host.fetch('https://example.test')).text(), 'original');
});
