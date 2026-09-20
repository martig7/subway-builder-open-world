import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPartitionIndex } from './partition-index.js';
import { createWasmTransitSearch } from '../commute-wasm/transit-search.js';
import { calculateCrossTileModeShares, createCrossTileRoutingCache, createNetworkProfile } from '../../src/runtime/cross-tile-mode-choice.js';
const bytes = await readFile(new URL('./transit-search.wasm', import.meta.url));
const withoutStats = ({ routingStats, ...result }) => result;

function fixture(seed) {
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const stations = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, coords: [i * 0.02, i % 2 * 0.001],
    buildType: 'constructed', stNodeIds: [`n${i}`], nearbyStations: i % 3 && i < 15 ? [{ stationId: `s${i + 1}`, walkingTime: 130 }] : [] }));
  const routes = Array.from({ length: 5 }, (_, r) => {
    const stops = stations.filter((_, i) => i === 0 || i === 15 || random() > 0.35);
    return { id: `r${r}`, idealTrainCount: 2 + r, stNodes: stops.map(s => ({ id: s.stNodeIds[0] })),
      stComboTimings: stops.map((_, i) => ({ stNodeIndex: i, arrivalTime: i * (100 + r * 30), departureTime: i * (100 + r * 30) + 20 })),
      ...(r === 1 ? { timetableSchedule: { mode: 'timetable', periods: [{ startHour: 22, endHour: 6, headwaySeconds: 90 }, { startHour: 6, endHour: 22, headwaySeconds: 240 }] } } : {}) };
  });
  return { worldId: 'partition-test', networkProfiles: { A: createNetworkProfile({ tileId: 'A', stations, routes,
    pathfindingRules: { DRIVE_TO_STATION_ACCESS: true, MAX_WALK_TO_FROM_STATION: 400 } }) }, gatewayCatalog: {}, fare: 3,
    includeJourneyDetails: true, crossDemand: { schemaVersion: 1, tileId: 'A', gateways: ['local'],
      points: stations.map((s, i) => [s.id, s.coords[0] + (i === 0 ? -0.005 : 0), s.coords[1], 'A']),
      popFields: ['id', 'mass', 'home', 'work', 'gateway', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime'],
      pops: Array.from({ length: 40 }, (_, i) => [`p${i}`, 70 + i, i % 2 ? 15 : 0, i % 2 ? 0 : 15, 0, 1800, 16000,
        [0, 21600, 79100, 86200][i % 4] + Math.floor(i / 4) * 19]) } };
}

test('conservative partition pruning preserves fixture results across schedules, transfers and driving access', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const input = fixture(seed);
    const partition = createPartitionIndex({ cellSize: 3 });
    const routingCache = createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes, { partition }) });
    const first = calculateCrossTileModeShares({ ...input, routingCache });
    assert.deepEqual(withoutStats(first), withoutStats(calculateCrossTileModeShares(input)), `seed ${seed}`);
    const warm = calculateCrossTileModeShares({ ...structuredClone(input), routingCache });
    assert.equal(warm.routingStats.searches, 0);
    assert.deepEqual(withoutStats(warm), withoutStats(first));
    assert.ok(partition.stats.cells > 1);
    for (const route of input.networkProfiles.A.routes) route.departureAnchorsByNode = { n0: [10.25, 50.75] };
    assert.deepEqual(withoutStats(calculateCrossTileModeShares({ ...input, routingCache })),
      withoutStats(calculateCrossTileModeShares(input)), `phases seed ${seed}`);
  }
});

// The rejected A* candidate remains reproducible. Matching the player capture
// is insufficient: queue ordering changes route attribution on this fixture.
test('A* is rejected by a known full-output parity counterexample', () => {
  const input = fixture(7), partition = createPartitionIndex({ cellSize: 3 });
  const routingCache = createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes, { partition, partitionMode: 2 }) });
  const expected = calculateCrossTileModeShares(input);
  const actual = calculateCrossTileModeShares({ ...input, routingCache });
  assert.notDeepEqual(withoutStats(actual), withoutStats(expected));
  const different = Object.keys(expected.journeyDetails).filter(id => JSON.stringify(actual.journeyDetails[id]) !== JSON.stringify(expected.journeyDetails[id]));
  assert.ok(different.length > 0, 'acceptance must include route attribution, not just mode choice totals');
  const journey = different[0];
  assert.equal(actual.journeyDetails[journey].totalSeconds, expected.journeyDetails[journey].totalSeconds);
  assert.deepEqual(actual.popModeChoices, expected.popModeChoices);
  assert.notDeepEqual(actual.journeyDetails[journey].stationRoutes, expected.journeyDetails[journey].stationRoutes);
});

test('graph/service/rule/World changes rebuild bounds and scratch overflow falls back', () => {
  const input = fixture(2), partition = createPartitionIndex({ cellSize: 4 });
  const routingCache = createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes, { partition }) });
  for (const change of ['initial', 'service', 'walk', 'world']) {
    if (change === 'service') input.networkProfiles.A.routes[0].serviceCount = 20;
    if (change === 'walk') input.networkProfiles.A.pathfindingRules.PERCEIVED_TIME.WALK_MULTIPLIER = 0.5;
    if (change === 'world') input.worldId = 'new-world';
    assert.deepEqual(withoutStats(calculateCrossTileModeShares({ ...input, routingCache })), withoutStats(calculateCrossTileModeShares(input)));
  }
  assert.equal(partition.stats.builds, 4);
  const fallback = createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes, { partition, labelCapacity: 1 }) });
  assert.deepEqual(withoutStats(calculateCrossTileModeShares({ ...input, routingCache: fallback })), withoutStats(calculateCrossTileModeShares(input)));
});

test('bounds follow directed paths through other cells and preserve unreachable stations', () => {
  const stations = ['a', 'b', 'c', 'd', 'isolated'].map(id => ({ id }));
  const edge = (to, seconds) => ({ to, seconds, type: 'walk' });
  const router = { stations, adjacency: new Map([
    ['a', [edge('b', 100), edge('c', 1)]], ['b', [edge('a', 100)]],
    ['c', [edge('d', 1)]], ['d', [edge('b', 1)]], ['isolated', []],
  ]) };
  const index = createPartitionIndex({ cellSize: 1 });
  const bounds = index.bounds(router, new Map([['b', 20]]), { PERCEIVED_TIME: {
    WALK_MULTIPLIER: 2, WAIT_MULTIPLIER: 1, DEPARTURE_SHIFT_MULTIPLIER: 1 }, ARRIVAL_GAP: 0 });
  assert.ok(bounds[0] > 5.99 && bounds[0] <= 6);
  assert.equal(bounds[1], 0);
  assert.equal(bounds[4], Infinity);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
});

test('destination catchments spanning cells use the minimum and reject negative weights', () => {
  const router = { stations: ['a', 'b', 'c'].map(id => ({ id })), adjacency: new Map([
    ['a', [{ type: 'ride', to: 'b', inVehicleSeconds: 10 }, { type: 'walk', to: 'c', seconds: 3 }]],
    ['b', []], ['c', []],
  ]) };
  const index = createPartitionIndex({ cellSize: 1 });
  const rules = { PERCEIVED_TIME: { WALK_MULTIPLIER: 2, WAIT_MULTIPLIER: 1, DEPARTURE_SHIFT_MULTIPLIER: 1 }, ARRIVAL_GAP: 0 };
  const both = index.bounds(router, new Map([['b', 0], ['c', 100]]), rules);
  assert.ok(both[0] > 5.99 && both[0] <= 6, 'egress omission remains optimistic even for a slower exit');
  assert.equal(index.bounds(router, new Map([['c', 100], ['b', 0]]), rules), both);
  assert.equal(index.stats.boundHits, 1);
  assert.throws(() => index.bounds(router, new Map([['b', 0]]), {
    ...rules, PERCEIVED_TIME: { ...rules.PERCEIVED_TIME, WALK_MULTIPLIER: -1 },
  }), /nonnegative/);
});
