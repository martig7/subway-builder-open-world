import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBoundedTransitSearch, BOUNDED_TRANSIT_SEARCH_VERSION, TRANSIT_SEARCH_WASM_SHA256 } from '../src/runtime/transit-search/index.js';
import { createBoundedPartitionIndex } from '../src/runtime/transit-search/partition-index.js';
import { transitSearchBytes } from '../src/runtime/transit-search/kernel-bytes.js';
import { calculateCrossTileModeShares, createCrossTileRoutingCache, createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';

const withoutStats = ({ routingStats, ...result }) => result;
function fixture(seed = 1) {
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const stations = Array.from({ length: 16 }, (_, index) => ({ id: `s${index}`, coords: [index * 0.02, index % 2 * 0.001],
    buildType: 'constructed', stNodeIds: [`n${index}`],
    nearbyStations: index % 3 && index < 15 ? [{ stationId: `s${index + 1}`, walkingTime: 130 }] : [] }));
  const routes = Array.from({ length: 5 }, (_, r) => {
    const stops = stations.filter((_, i) => i === 0 || i === 15 || random() > 0.35);
    return { id: `r${r}`, idealTrainCount: 2 + r, stNodes: stops.map(s => ({ id: s.stNodeIds[0] })),
      stComboTimings: stops.map((_, i) => ({ stNodeIndex: i, arrivalTime: i * (100 + r * 30), departureTime: i * (100 + r * 30) + 20 })),
      ...(r === 1 ? { timetableSchedule: { mode: 'timetable', periods: [{ startHour: 22, endHour: 6, headwaySeconds: 90 }, { startHour: 6, endHour: 22, headwaySeconds: 240 }] } } : {}) };
  });
  return { worldId: 'bounded-search-test', networkProfiles: { A: createNetworkProfile({ tileId: 'A', stations, routes,
    pathfindingRules: { DRIVE_TO_STATION_ACCESS: true, MAX_WALK_TO_FROM_STATION: 400 } }) }, gatewayCatalog: {}, fare: 3,
    includeJourneyDetails: true, crossDemand: { schemaVersion: 1, tileId: 'A', gateways: ['local'],
      points: stations.map((station, index) => [station.id, station.coords[0] + (index === 0 ? -0.005 : 0), station.coords[1], 'A']),
      popFields: ['id', 'mass', 'home', 'work', 'gateway', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime'],
      pops: Array.from({ length: 40 }, (_, index) => [`p${index}`, 70 + index, index % 2 ? 15 : 0, index % 2 ? 0 : 15, 0, 1800, 16000,
        [0, 21600, 79100, 86200][index % 4] + Math.floor(index / 4) * 19]) } };
}
function smallGraph() {
  const edge = (to, seconds) => ({ to, seconds, type: 'walk', toStateKey: `${to}\0` });
  return { stations: ['a', 'b', 'c', 'd', 'isolated'].map(id => ({ id })), cacheEnabled: false,
    adjacency: new Map([['a', [edge('b', 100), edge('c', 1)]], ['b', [edge('a', 100)]],
      ['c', [edge('d', 1)]], ['d', [edge('b', 1)]], ['isolated', []]]) };
}
const rules = { PERCEIVED_TIME: { WALK_MULTIPLIER: 2, WAIT_MULTIPLIER: 1, DEPARTURE_SHIFT_MULTIPLIER: 1 }, ARRIVAL_GAP: 0 };
const query = (overrides = {}) => ({ starts: [['a', { seconds: 0, mode: 'walk' }]], ends: new Map([['b', 20]]),
  requestedDepartureSeconds: 0, bound: Infinity, rules, ...overrides });

test('embedded browser-compatible bytes retain the measured kernel hash and no imports', () => {
  const bytes = transitSearchBytes();
  assert.equal(bytes.length, 3449);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), TRANSIT_SEARCH_WASM_SHA256);
  assert.equal(TRANSIT_SEARCH_WASM_SHA256, '254c44bf178834301556f40c850a9c9128f1157a7ba1368b372d30a375ea15db');
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
});

test('lazy lifecycle drops graph, instance linear memory and partition tables on clear/dispose', () => {
  const kernel = createBoundedTransitSearch(), router = smallGraph();
  assert.equal(kernel.stats.version, BOUNDED_TRANSIT_SEARCH_VERSION);
  assert.equal(kernel.stats.instances, 0);
  assert.equal(kernel.stats.linearMemoryBytes, 0);
  assert.equal(kernel.search(router, query()).available, true);
  assert.equal(kernel.stats.instances, 1);
  assert.ok(kernel.stats.linearMemoryBytes > 0);
  assert.ok(kernel.stats.partition.tableBytes > 0);
  kernel.clear();
  assert.equal(kernel.stats.linearMemoryBytes, 0);
  assert.equal(kernel.stats.retainedEdges, 0);
  assert.equal(kernel.stats.partition.tableBytes, 0);
  assert.equal(kernel.stats.partition.cachedBytes, 0);
  kernel.search(router, query());
  assert.equal(kernel.stats.instances, 2);
  kernel.dispose();
  assert.equal(kernel.stats.linearMemoryBytes, 0);
});

test('cost-first partition search preserves complete journeys, fares and modes across schedules and graph changes', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const input = fixture(seed), kernel = createBoundedTransitSearch({ partitionOptions: { cellSize: 3 } });
    const cache = createCrossTileRoutingCache({ searchKernel: kernel });
    for (const change of ['initial', 'phases', 'service', 'walk', 'world']) {
      if (change === 'phases') for (const route of input.networkProfiles.A.routes) route.departureAnchorsByNode = { n0: [10.25, 50.75] };
      if (change === 'service') input.networkProfiles.A.routes[0].serviceCount = 20;
      if (change === 'walk') input.networkProfiles.A.pathfindingRules.PERCEIVED_TIME.WALK_MULTIPLIER = 0.5;
      if (change === 'world') input.worldId = 'new-world';
      const expected = calculateCrossTileModeShares({ ...input, routingCache: createCrossTileRoutingCache({ searchKernel: null }) });
      const actual = calculateCrossTileModeShares({ ...input, routingCache: cache });
      assert.deepEqual(withoutStats(actual), withoutStats(expected), `seed ${seed}: ${change}`);
    }
    assert.equal(kernel.stats.fallbacks, 0);
    assert.ok(kernel.stats.builds >= 4);
  }
});

test('unavailable WebAssembly and bounded scratch overflow preserve results through JavaScript fallback', () => {
  const input = fixture(7);
  const expected = calculateCrossTileModeShares({ ...input, routingCache: createCrossTileRoutingCache({ searchKernel: null }) });
  for (const options of [{ webAssembly: null }, { labelCapacity: 1 }, { maxMemoryBytes: 1024 }]) {
    const kernel = createBoundedTransitSearch(options);
    const actual = calculateCrossTileModeShares({ ...input, routingCache: createCrossTileRoutingCache({ searchKernel: kernel }) });
    assert.deepEqual(withoutStats(actual), withoutStats(expected));
    assert.ok(kernel.stats.fallbacks > 0);
    if (options.webAssembly !== null) assert.ok(kernel.stats.memoryFallbacks > 0);
  }
});

test('graph preflight rejects excessive station, edge and packed schedule counts before Wasm instantiation', () => {
  for (const options of [{ maxStations: 1 }, { maxEdges: 1 }, { maxStates: 1 }]) {
    const kernel = createBoundedTransitSearch(options);
    assert.equal(kernel.search(smallGraph(), query()), null);
    assert.equal(kernel.stats.instances, 0);
    assert.ok(kernel.stats.memoryFallbacks > 0);
  }
  const router = smallGraph();
  const edge = router.adjacency.get('a')[0];
  edge.route = { timetableSchedule: { mode: 'timetable', periods: { length: 10_000_000 } } };
  const kernel = createBoundedTransitSearch();
  assert.equal(kernel.search(router, query()), null);
  assert.equal(kernel.stats.instances, 0);
  assert.equal(kernel.stats.lastFallback, 'packed-graph-memory-limit');
});

test('large requested label counts clamp to a whole-page memory budget and disconnected paths stay unavailable', () => {
  const kernel = createBoundedTransitSearch({ maxMemoryBytes: 256 * 1024, labelCapacity: 1_000_000 });
  const router = smallGraph();
  assert.equal(kernel.search(router, query()).available, true);
  assert.ok(kernel.stats.labelCapacity < 1_000_000);
  assert.ok(kernel.stats.linearMemoryBytes <= 256 * 1024);
  assert.equal(kernel.search(router, query({ ends: new Map([['isolated', 0]]) })).available, false);
  assert.equal(kernel.search(router, query({ starts: [], ends: new Map() })).available, false);
});

test('partition resource caps disable pruning while leaving exact Wasm search usable', () => {
  for (const partitionOptions of [{ maxBytes: 1 }, { maxStations: 1 }, { maxBuildWork: 1 }]) {
    const kernel = createBoundedTransitSearch({ partitionOptions });
    const result = kernel.search(smallGraph(), query());
    assert.deepEqual(result.edges.map(edge => edge.to), ['c', 'd', 'b']);
    assert.equal(kernel.stats.fallbacks, 0);
    assert.equal(kernel.stats.partition.disabledBuilds, 1);
    assert.equal(kernel.stats.partition.tableBytes, 0);
  }
});

test('directed lower bounds remain optimistic and cached bound storage stays within its byte cap', () => {
  const router = smallGraph(), index = createBoundedPartitionIndex({ cellSize: 1, maxBytes: 280 });
  const bounds = index.bounds(router, new Map([['b', 20]]), rules);
  assert.ok(bounds[0] > 5.99 && bounds[0] <= 6);
  assert.equal(bounds[1], 0);
  assert.equal(bounds[4], Infinity);
  for (const station of router.stations) {
    index.bounds(router, new Map([[station.id, 0]]), rules);
    assert.ok(index.stats.tableBytes + index.stats.cachedBytes <= 280);
  }
  index.clear();
  assert.equal(index.stats.tableBytes + index.stats.cachedBytes, 0);
});

test('instantiation errors release retained state and do not repeatedly compile the same rejected router', () => {
  let attempts = 0;
  const kernel = createBoundedTransitSearch({ webAssembly: {
    Module: class { constructor() { attempts++; throw new Error('blocked'); } }, Instance: class {},
  } });
  const router = smallGraph();
  assert.equal(kernel.search(router, query()), null);
  assert.equal(kernel.search(router, query()), null);
  assert.equal(attempts, 1);
  assert.equal(kernel.stats.linearMemoryBytes, 0);
  kernel.clear(); kernel.search(router, query());
  assert.equal(attempts, 2);
});
