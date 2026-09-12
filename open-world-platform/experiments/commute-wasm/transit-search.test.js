import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWasmTransitSearch } from './transit-search.js';
import { calculateCrossTileModeShares, createCrossTileRoutingCache, createNetworkProfile } from '../../src/runtime/cross-tile-mode-choice.js';

const bytes = await readFile(new URL('./transit-search.wasm', import.meta.url));
const outcome = ({ routingStats, ...value }) => value;
const evaluate = (input, options) => calculateCrossTileModeShares({ ...input, includeJourneyDetails: true,
  routingCache: createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes, options) }) });
function fixture(seed = 1) {
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const stations = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, coords: [i * 0.02, i % 2 * 0.001], buildType: 'constructed',
    stNodeIds: [`n${i}`], nearbyStations: i < 7 && i % 2 ? [{ stationId: `s${i+1}`, walkingTime: 130 }] : [] }));
  const routes = Array.from({ length: 4 }, (_, r) => {
    const stops = stations.filter((_, i) => i === 0 || i === 7 || random() > 0.35);
    return { id: `r${r}`, idealTrainCount: 2 + r,
      stNodes: stops.map(station => ({ id: station.stNodeIds[0] })),
      stComboTimings: stops.map((_, i) => ({ stNodeIndex: i, arrivalTime: i * (100 + r * 30), departureTime: i * (100 + r * 30) + 20 })),
      ...(r === 1 ? { timetableSchedule: { mode: 'timetable', periods: [{ startHour: 22, endHour: 6, headwaySeconds: 90 }, { startHour: 6, endHour: 22, headwaySeconds: 240 }] } } : {}),
    };
  });
  const profile = createNetworkProfile({ tileId: 'A', stations, routes,
    pathfindingRules: { DRIVE_TO_STATION_ACCESS: true, MAX_WALK_TO_FROM_STATION: 400 } });
  return { worldId: 'wasm-parity', networkProfiles: { A: profile }, gatewayCatalog: {}, fare: 3,
    includeJourneyDetails: true,
    crossDemand: { schemaVersion: 1, tileId: 'A', gateways: ['local'],
      points: stations.map((station, i) => [station.id, station.coords[0] + (i === 0 ? -0.005 : 0), station.coords[1], 'A']),
      popFields: ['id', 'mass', 'home', 'work', 'gateway', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime'],
      pops: Array.from({ length: 24 }, (_, i) => [`p${i}`, 70 + i, i % 2 ? 7 : 0, i % 2 ? 0 : 7, 0, 1800, 16000, [0, 21600, 79100, 86200][i % 4] + Math.floor(i / 4) * 19]) } };
}

test('C++ module needs no imports and bounded scratch uses the JavaScript fallback', () => {
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
  const input = fixture();
  assert.deepEqual(outcome(evaluate(input, { labelCapacity: 1 })), outcome(calculateCrossTileModeShares(input)));
});

test('C++ preserves full journeys, schedules, access-only driving, transfers and ties', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const input = fixture(seed);
    assert.deepEqual(outcome(evaluate(input)), outcome(calculateCrossTileModeShares(input)), `seed ${seed}`);
    for (const route of input.networkProfiles.A.routes) route.departureAnchorsByNode = { n0: [10.25, 50.75] };
    assert.deepEqual(outcome(evaluate(input)), outcome(calculateCrossTileModeShares(input)), `departure phases ${seed}`);
  }
});

test('C++ graph replacement and exact-path cache preserve world and service invalidation', () => {
  const input = fixture(), routingCache = createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes) });
  const first = calculateCrossTileModeShares({ ...input, routingCache });
  const repeat = calculateCrossTileModeShares({ ...structuredClone(input), routingCache });
  assert.deepEqual(outcome(repeat), outcome(first));
  assert.equal(repeat.routingStats.searches, 0);
  input.networkProfiles.A.routes[0].serviceCount = 20;
  assert.deepEqual(outcome(calculateCrossTileModeShares({ ...input, routingCache })), outcome(calculateCrossTileModeShares(input)));
  input.worldId = 'another-world';
  assert.deepEqual(outcome(calculateCrossTileModeShares({ ...input, routingCache })), outcome(calculateCrossTileModeShares(input)));
});
