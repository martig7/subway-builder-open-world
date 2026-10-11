import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagerStationNaming, readNativeStationNamingScheme, MANAGER_STATION_NAMING_VERSION } from '../src/runtime/manager-station-naming.js';
import { createStationNameRepair } from '../src/runtime/station-name-repair.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';

const station = id => ({ id, point: [139, 35], centerLine: [[139, 34.999], [139, 35.001]], excludeName: 'Station' });
const tileCatalog = { tiles: [{ id: 'JP_LOCAL', bounds: [138.9, 34.9, 139.1, 35.1] },
  { id: 'JP_HALO', haloBounds: [138.98, 34.98, 139.02, 35.02] }, { id: 'JP_DISTANT', bounds: [140, 36, 141, 37] }] };
function clientHarness(options = {}) {
  const calls = [];
  const processing = { settings: async () => ({ stationNamingEnabled: options.enabled ?? true }),
    request: async (url, body, requestOptions) => {
      calls.push({ url, body, requestOptions });
      if (options.respond) return options.respond(body);
      return { version: MANAGER_STATION_NAMING_VERSION, requestId: body.requestId, contextKey: body.contextKey,
        names: body.stations.map(({ id }) => ({ id, name: 'Manager St' })) };
    } };
  let serial = 0;
  const naming = createManagerStationNaming({ processing, tileCatalog, requestId: () => `request-${++serial}`,
    getNamingScheme: async () => 'intersection' });
  return { calls, naming };
}

test('default-off manager naming issues no station or road request', async () => {
  const h = clientHarness({ enabled: false });
  assert.equal(await h.naming.resolve({ stations: [station('a')], contextKey: 'epoch' }), null);
  assert.equal(h.calls.length, 0);
});

test('manager naming scopes installed road lookups near stations and splits bounded batches', async () => {
  const h = clientHarness();
  const stations = Array.from({ length: 65 }, (_, index) => station(String(index)));
  const result = await h.naming.resolve({ stations, contextKey: 42 });
  assert.equal(result.length, 65);
  assert.deepEqual(h.calls.map(({ body }) => body.stations.length), [32, 32, 1]);
  assert.deepEqual(h.calls[0].body.tileIds, ['JP_LOCAL', 'JP_HALO']);
  assert.equal(h.calls[0].body.namingScheme, 'intersection');
  assert.equal(h.calls[0].body.contextKey, '42');
  assert.equal(h.calls[0].url, '/_processing/station-names');
});

for (const corruption of ['request', 'context', 'duplicate', 'foreign', 'name']) {
  test(`manager naming rejects ${corruption} response corruption`, async () => {
    const h = clientHarness({ respond: body => {
      const result = { version: MANAGER_STATION_NAMING_VERSION, requestId: body.requestId, contextKey: body.contextKey,
        names: [{ id: 'a', name: 'Name A' }, { id: 'b', name: null }] };
      if (corruption === 'request') result.requestId = 'old';
      if (corruption === 'context') result.contextKey = 'old';
      if (corruption === 'duplicate') result.names[1].id = 'a';
      if (corruption === 'foreign') result.names[1].id = 'other';
      if (corruption === 'name') result.names[1].name = {};
      return result;
    } });
    await assert.rejects(h.naming.resolve({ stations: [station('a'), station('b')], contextKey: 'epoch' }), /stale|invalid/);
  });
}

test('manager naming discards changed contexts and cancelled requests after awaiting backend', async () => {
  let current = true;
  const h = clientHarness({ respond: () => { current = false; return {}; } });
  assert.equal(await h.naming.resolve({ stations: [station('a')], contextKey: 'epoch', isCurrent: () => current }), null);
  const abort = new AbortController();
  const c = clientHarness({ respond: () => { abort.abort(); return {}; } });
  await assert.rejects(c.naming.resolve({ stations: [station('a')], contextKey: 'epoch', signal: abort.signal }), /abort/i);
});

test('native naming scheme read honors intersection and cross street settings', async () => {
  assert.equal(await readNativeStationNamingScheme({ getSetting: async key => ({ success: key === 'stationNamingScheme', value: 'intersection' }) }), 'intersection');
  assert.equal(await readNativeStationNamingScheme({ getSetting: async () => ({ success: true, value: 'cross-street' }) }), 'cross-street');
});

function gameHarness() {
  const calls = [];
  let epoch = 1;
  const stations = [{ id: 'a', name: 'Station', trackGroupId: 'a', coords: [139, 35] },
    { id: 'b', name: 'Station', trackGroupId: 'b', coords: [139, 35] }, { id: 'custom', name: 'Custom' }];
  let state = { cityCode: 'JP_LOCAL', stations, stationsMap: new Map(stations.map(station => [station.id, station])),
    trackGroups: ['a', 'b'].map(id => ({ id, centerLine: [[139, 34.999], [139, 35.001]] })), roadsIndex: { search: () => [] } };
  state.updateStationName = (id, request) => {
    calls.push({ id, request });
    const next = state.stations.map(station => station.id === id ? { ...station, name: request.newName ?? 'Station' } : station);
    state = { ...state, stations: next, stationsMap: new Map(next.map(station => [station.id, station])) };
  };
  const game = new SubwayBuilderGameAdapter({ api: { gameState: { getGameSessionId: () => epoch } }, callbacks: { getState: () => state } });
  return { game, calls, read: () => state, change: patch => { state = { ...state, ...patch }; }, changeSession: () => { epoch++; } };
}

test('repair applies manager off-tile names through native actions and keeps player edits', async () => {
  const h = gameHarness();
  const managerNaming = { resolve: async ({ stations }) => {
    assert.deepEqual(stations.map(({ id }) => id), ['a', 'b']);
    assert.deepEqual(stations[0].point, [139, 35]);
    const next = h.read().stations.map(station => station.id === 'b' ? { ...station, name: 'Player edit' } : station);
    h.change({ stations: next, stationsMap: new Map(next.map(station => [station.id, station])) });
    return [{ id: 'a', name: 'Manager intersection' }, { id: 'b', name: 'Manager B' }];
  } };
  const result = await createStationNameRepair({ game: h.game, managerNaming, yieldTask: async () => {} }).run();
  assert.equal(result.status, 'completed');
  assert.equal(result.renamed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(result.processed, 2);
  assert.deepEqual(h.calls, [{ id: 'a', request: { type: 'newName', newName: 'Manager intersection' } }]);
  assert.equal(h.read().stationsMap.get('b').name, 'Player edit');
  assert.equal(h.read().stationsMap.get('custom').name, 'Custom');
});

for (const change of ['session', 'topology', 'city']) {
  test(`repair rejects manager results after ${change} changes`, async () => {
    const h = gameHarness();
    const managerNaming = { resolve: async () => {
      if (change === 'session') h.changeSession();
      if (change === 'topology') h.change({ trackGroups: [] });
      if (change === 'city') h.change({ cityCode: 'JP_OTHER' });
      return [{ id: 'a', name: 'Stale' }];
    } };
    const result = await createStationNameRepair({ game: h.game, managerNaming, yieldTask: async () => {} }).run();
    assert.equal(result.status, 'cancelled');
    assert.equal(h.calls.length, 0);
  });
}

test('repair disposal aborts a pending manager job and never mutates stations', async () => {
  const h = gameHarness();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let signal;
  const managerNaming = { resolve: ({ signal: value }) => { signal = value; started(); return new Promise((_, reject) => value.addEventListener('abort', () => reject(value.reason))); } };
  const repair = createStationNameRepair({ game: h.game, managerNaming, yieldTask: async () => {} });
  const run = repair.run();
  await pending;
  repair.dispose();
  assert.equal(signal.aborted, true);
  assert.equal((await run).status, 'cancelled');
  assert.equal(h.calls.length, 0);
});
