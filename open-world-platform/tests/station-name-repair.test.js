import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { createStationNameRepair, isBlankStationName, stationNameRepairText } from '../src/runtime/station-name-repair.js';
import { RenderDistancePanel, registerRenderDistanceToolbar } from '../src/runtime/ui/render-distance-panel.js';

function harness(stations, options = {}) {
  const calls = [];
  let state = { cityCode: 'JP_PREF_27', trackGroups: [], roadsIndex: { search: () => [] },
    stations, stationsMap: new Map(stations.map(station => [station.id, station])) };
  state.updateStationName = (id, request) => {
    calls.push([id, request]);
    if (id === options.failId) throw new Error('Road lookup failed');
    const name = options.names?.[id] ?? 'Station';
    const next = state.stations.map(station => station.id === id ? { ...station, name } : station);
    state = { ...state, stations: next, stationsMap: new Map(next.map(station => [station.id, station])),
      stationGroups: [{ name: 'Player’s group name', customName: 'Player’s group name' }] };
  };
  const game = new SubwayBuilderGameAdapter({ api: { gameState: { getGameSessionId: () => 'session' } },
    callbacks: { getState: () => state } });
  return { game, calls, read: () => state, change: patch => { state = { ...state, ...patch }; } };
}

test('native automatic naming fills default/empty names across the whole network and preserves other names', async () => {
  const h = harness([
    { id: 'local', name: 'Station', coords: [135, 34] },
    { id: 'empty', name: '' }, { id: 'space', name: '  ' },
    { id: 'off', name: 'Station', coords: [139, 35] },
    { id: 'no-roads', name: 'Station' },
    { id: 'custom', name: 'My station' }, { id: 'numbered', name: 'Station 2' },
  ], { names: { local: 'Native cross street', empty: 'Native intersection/name', space: 'Native street', off: 'Native off-tile name' } });
  let yields = 0;
  const repair = createStationNameRepair({ game: h.game, batchSize: 2, now: () => 0,
    yieldTask: async () => { yields++; } });
  repair.snapshot();
  assert.equal(h.calls.length, 0, 'opening settings performs no renames');
  const result = await repair.run();
  assert.deepEqual(h.calls, ['local', 'empty', 'space', 'off', 'no-roads'].map(id => [id, { type: 'auto' }]));
  assert.equal(result.status, 'completed');
  assert.equal(result.renamed, 4);
  assert.equal(result.unresolved, 1);
  assert.equal(result.processed, 5);
  assert.equal(yields, 3, 'initial paint and two bounded batches');
  assert.equal(h.read().stationsMap.get('custom').name, 'My station');
  assert.equal(h.read().stationsMap.get('numbered').name, 'Station 2');
  assert.equal(h.read().stationGroups[0].customName, 'Player’s group name');
  h.calls.length = 0;
  await repair.run();
  assert.deepEqual(h.calls.map(([id]) => id), ['no-roads'], 'only unresolved names are retried');
});

test('refresh reads each fresh native snapshot and skips names edited during a batch', async () => {
  const h = harness([{ id: 'a', name: 'Station' }, { id: 'b', name: 'Station' }, { id: 'c', name: '' }],
    { names: { a: 'Native A', b: 'Native B', c: 'Native C' } });
  let yields = 0;
  const repair = createStationNameRepair({ game: h.game, batchSize: 1, yieldTask: async () => {
    if (++yields === 2) {
      const stations = h.read().stations.filter(station => station.id !== 'c').map(station =>
        station.id === 'b' ? { ...station, name: 'Player edit' } : station);
      h.change({ stations, stationsMap: new Map(stations.map(station => [station.id, station])) });
    }
  } });
  const result = await repair.run();
  assert.equal(result.renamed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(h.read().stationsMap.get('a').name, 'Native A');
  assert.equal(h.read().stationsMap.get('b').name, 'Player edit');
  assert.equal(h.calls.length, 1);
});

test('distant defaults avoid native group rebuilds without skipping empty names or covered platforms', async () => {
  const h = harness([
    { id: 'far', trackGroupId: 'far', name: 'Station', coords: [0, 0] },
    { id: 'empty', trackGroupId: 'empty', name: '' },
    { id: 'covered', trackGroupId: 'covered', name: 'Station' },
  ], { names: { covered: 'Native street' } });
  const searches = [];
  h.change({ trackGroups: [
    { id: 'far', centerLine: [[139, 35], [139.001, 35.001]] },
    { id: 'empty', centerLine: [[139, 35], [139.001, 35.001]] },
    { id: 'covered', centerLine: [[135, 34], [135.001, 34.001]] },
  ], roadsIndex: { search: bounds => { searches.push(bounds); return bounds.minX > 138 ? [] : [{}]; } } });
  const result = await createStationNameRepair({ game: h.game, yieldTask: async () => {} }).run();
  assert.equal(result.renamed, 1);
  assert.equal(result.unresolved, 2);
  assert.deepEqual(h.calls.map(([id]) => id), ['empty', 'covered']);
  assert.equal(h.read().stationsMap.get('empty').name, 'Station', 'native fallback still applies to empty names');
  assert.deepEqual(searches[0], { minX: 139 - .01, minY: 35 - .01, maxX: 139.001 + .01, maxY: 35.001 + .01 });
});

test('overlapping clicks share one run, and a slow native rename yields before the next station', async () => {
  const h = harness([{ id: 'a', name: 'Station' }, { id: 'b', name: 'Station' }], { names: { a: 'A', b: 'B' } });
  let release;
  let time = 0;
  let yields = 0;
  const repair = createStationNameRepair({ game: h.game, now: () => time,
    yieldTask: () => { yields++; return new Promise(resolve => { release = resolve; }); } });
  const original = h.read().updateStationName;
  h.change({ updateStationName: (...args) => { original(...args); time += 20; } });
  const first = repair.run();
  assert.equal(repair.run(), first);
  assert.equal(repair.snapshot().status, 'running');
  assert.equal(h.calls.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(yields, 2);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 2);
  release();
  assert.equal((await first).renamed, 2);
});

for (const change of ['city', 'roads', 'network', 'load', 'dispose', 'save']) {
  test(`stops between batches when ${change} changes`, async () => {
    const h = harness([{ id: 'a', name: 'Station' }, { id: 'b', name: 'Station' }], { names: { a: 'A', b: 'B' } });
    let epoch = 1;
    let ready = true;
    let yields = 0;
    const repair = createStationNameRepair({ game: h.game, batchSize: 1, getContextKey: () => epoch,
      isReady: () => ready, yieldTask: async () => {
        if (++yields !== 2) return;
        if (change === 'city') h.change({ cityCode: 'JP_PREF_12' });
        if (change === 'roads') h.change({ roadsIndex: { search: () => [] } });
        if (change === 'network') h.change({ trackGroups: [] });
        if (change === 'load') epoch++;
        if (change === 'dispose') repair.dispose();
        if (change === 'save') ready = false;
      } });
    const result = await repair.run();
    assert.equal(result.status, 'cancelled');
    assert.equal(result.renamed, 1);
    assert.deepEqual(h.calls.map(([id]) => id), ['a']);
  });
}

test('individual failures are reported while remaining stations continue', async () => {
  const h = harness([{ id: 'bad', name: 'Station' }, { id: 'good', name: 'Station' }],
    { failId: 'bad', names: { good: 'Native name' } });
  const result = await createStationNameRepair({ game: h.game, yieldTask: async () => {} }).run();
  assert.equal(result.renamed, 1);
  assert.equal(result.failed, 1);
  assert.match(stationNameRepairText(result), /1 failed: Road lookup failed/);
});

test('unavailable native naming reports a failure without changing stations', async () => {
  const h = harness([{ id: 'a', name: 'Station' }]);
  h.change({ updateStationName: undefined });
  const result = await createStationNameRepair({ game: h.game, yieldTask: async () => {} }).run();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /unavailable/);
  assert.equal(h.calls.length, 0);
  assert.equal(isBlankStationName(null), true);
  assert.equal(isBlankStationName(' Station '), true);
  assert.equal(isBlankStationName('Station Road'), false);
});

function* nodes(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

test('settings button runs the repair and displays progress with accessible status', () => {
  let runs = 0;
  let status = 'idle';
  let available = true;
  const stationNames = { snapshot: () => ({ status, available, processed: 2, total: 4 }),
    subscribe: () => () => {}, run: () => { runs++; } };
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: effect => effect() };
  const controller = { getRenderDistance: () => 3, subscribeRenderDistance: () => () => {} };
  const render = () => [...nodes(RenderDistancePanel({ React, controller, stationNames }))];
  let tree = render();
  let button = tree.find(node => node.type === 'button' && node.children.includes('Fill blank station names'));
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(runs, 1);
  status = 'running';
  tree = render();
  button = tree.find(node => node.type === 'button');
  assert.equal(button.props.disabled, true);
  assert.ok(tree.some(node => node.props.role === 'status' && node.props['aria-live'] === 'polite'
    && node.children.includes('Naming stations… 2 of 4')));
  status = 'idle'; available = false;
  assert.equal(render().find(node => node.type === 'button').props.disabled, true);
  let registration;
  registerRenderDistanceToolbar({ api: { utils: { React }, ui: { addToolbarPanel: value => { registration = value; } } },
    controller, stationNames });
  assert.equal(registration.render().props.stationNames, stationNames);
});
