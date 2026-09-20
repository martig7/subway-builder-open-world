import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRouteReuseSearch, replayRouteCandidate } from './route-reuse.js';
import { createWasmTransitSearch } from '../commute-wasm/transit-search.js';
import { createCrossTileRoutingCache, createNetworkProfile, calculateCrossTileModeShares } from '../../src/runtime/cross-tile-mode-choice.js';

const bytes = await readFile(new URL('../commute-wasm/transit-search.wasm', import.meta.url));
function fixture({ timetable = null, phases = null, service = 1 } = {}) {
  const stations = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, coords: [i * 0.02, 0],
    buildType: 'constructed', stNodeIds: [`n${i}`], nearbyStations: [] }));
  const route = { id: 'r', idealTrainCount: service, stNodes: stations.slice(0, 4).map(s => ({ id: s.stNodeIds[0] })),
    stComboTimings: [0, 100, 220, 340].map((arrivalTime, index) => ({ stNodeIndex: index, arrivalTime, departureTime: arrivalTime + 20 })),
    ...(timetable ? { timetableSchedule: timetable } : {}) };
  const profile = createNetworkProfile({ tileId: 'A', stations, routes: [route],
    pathfindingRules: { MAX_WALK_TO_FROM_STATION: 500 } });
  if (phases) profile.routes[0].departureAnchorsByNode = phases;
  const router = createCrossTileRoutingCache().getRouter({ A: profile });
  return { profile, router, stations };
}
const queryFor = (router, overrides = {}) => ({ starts: [['s0', { seconds: 23, mode: 'walk' }]],
  ends: new Map([['s3', 44]]), rules: router.defaultRules, requestedDepartureSeconds: 1_000, bound: Infinity, ...overrides });
const topology = result => ({ sourceStationId: result.source[0], edges: result.edges });
const comparable = result => ({ available: result.available, source: result.source,
  egressWalkSeconds: result.egressWalkSeconds, edges: result.edges });

test('reused paths replay exact access, egress, train phases, dwell and departure shifts', () => {
  const { router } = fixture({ phases: { n0: [10, 120], n1: [110, 220], n2: [230, 340] } });
  const baseline = createWasmTransitSearch(bytes);
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes));
  reuse.search(router, queryFor(router));
  for (const requestedDepartureSeconds of [1001, 1234, 86_390, 86_410]) {
    const query = queryFor(router, { requestedDepartureSeconds,
      starts: [['s0', { seconds: 37, mode: 'drive' }]], ends: new Map([['s3', 71]]) });
    const actual = reuse.search(router, query), expected = baseline.search(router, query);
    assert.deepEqual(comparable(actual), comparable(expected));
    const expectedReplay = replayRouteCandidate(topology(expected), query).result;
    assert.equal(actual.perceivedSeconds, expectedReplay.perceivedSeconds);
    assert.equal(actual.totalClockSeconds, expectedReplay.totalClockSeconds);
  }
  assert.equal(reuse.stats.hits, 4);
  assert.equal(reuse.stats.exactSearches, 1);
});

test('candidate may join and leave at different currently eligible stations', () => {
  const { router } = fixture();
  const baseline = createWasmTransitSearch(bytes);
  const candidate = topology(baseline.search(router, queryFor(router)));
  const query = queryFor(router, { starts: [['s1', { seconds: 20, mode: 'walk' }]], ends: new Map([['s2', 30]]) });
  const replay = replayRouteCandidate(candidate, query).result;
  const exact = baseline.search(router, query);
  assert.deepEqual(comparable(replay), comparable(exact));
  assert.equal(replay.edges.length, 1);
  assert.equal(replay.source[0], 's1');
  assert.equal(replay.egressWalkSeconds, 30);
});

test('timetable closure rejects a cached topology and invokes the exact fallback', () => {
  const { router } = fixture({ timetable: { mode: 'timetable', periods: [{ startHour: 22, endHour: 6, headwaySeconds: 120 }] } });
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes));
  assert.equal(reuse.search(router, queryFor(router)).available, true);
  assert.equal(reuse.search(router, queryFor(router, { requestedDepartureSeconds: 12 * 3600 })).available, false);
  assert.equal(reuse.stats.hits, 0);
  assert.equal(reuse.stats.exactSearches, 2);
  assert.equal(reuse.stats.candidatesRejected, 1);
});

test('graph and service replacement clear all cached edge references', () => {
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes));
  const first = fixture(), second = fixture({ service: 3 });
  reuse.search(first.router, queryFor(first.router));
  const actual = reuse.search(second.router, queryFor(second.router));
  const expected = createWasmTransitSearch(bytes).search(second.router, queryFor(second.router));
  assert.deepEqual(comparable(actual), comparable(expected));
  assert.equal(reuse.stats.resets, 2);
  assert.equal(reuse.stats.hits, 0);
  assert.equal(reuse.stats.retainedMenus, 1);
  assert.ok(actual.edges.every(edge => second.router.adjacency.get('s0').includes(edge)
    || second.router.adjacency.get('s1').includes(edge) || second.router.adjacency.get('s2').includes(edge)));
});

test('unreachable, empty, and incumbent-bound queries never gain an invented journey', () => {
  const { router } = fixture();
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes));
  reuse.search(router, queryFor(router));
  assert.equal(reuse.search(router, queryFor(router, { ends: new Map([['s4', 0]]) })).available, false);
  assert.equal(reuse.search(router, queryFor(router, { ends: new Map() })).available, false);
  assert.equal(reuse.search(router, queryFor(router, { starts: [] })).available, false);
  assert.equal(reuse.search(router, queryFor(router, { bound: 1 })).available, false);
  const noBoarding = replayRouteCandidate({ sourceStationId: 's0', edges: [] }, queryFor(router, {
    starts: [['s0', { seconds: 1, mode: 'drive' }]], ends: new Map([['s0', 1]]),
  })).result;
  assert.equal(noBoarding, null);
});

test('retention has hard menu, path length and total edge limits', () => {
  const { router } = fixture();
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes), { maxEntries: 2, maxRetainedEdges: 3 });
  for (let index = 1; index <= 3; index++) {
    reuse.search(router, queryFor(router, { ends: new Map([[`s${index}`, 0]]) }));
    assert.ok(reuse.stats.retainedMenus <= 2);
    assert.ok(reuse.stats.retainedEdges <= 3);
  }
  assert.ok(reuse.stats.evictions > 0);
  const short = createRouteReuseSearch(createWasmTransitSearch(bytes), { maxCandidateEdges: 1 });
  short.search(router, queryFor(router));
  assert.equal(short.stats.retainedMenus, 0);
  assert.equal(short.stats.retainedEdges, 0);
  assert.throws(() => createRouteReuseSearch({}, { maxEntries: Infinity }), /positive integer/);
  reuse.clear();
  assert.equal(reuse.stats.retainedEdges, 0);
  assert.equal(reuse.stats.retainedMenus, 0);
});

test('deterministic audit periodically refreshes candidates and reports cost error', () => {
  const { router } = fixture();
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes), { auditEvery: 2 });
  for (let index = 0; index < 5; index++) reuse.search(router, queryFor(router, { requestedDepartureSeconds: 1000 + index }));
  assert.equal(reuse.stats.hits, 4);
  assert.equal(reuse.stats.audits, 2);
  assert.equal(reuse.stats.exactSearches, 3);
  assert.equal(reuse.stats.auditWorse, 0);
  assert.equal(reuse.stats.auditMaximumCostErrorSeconds, 0);
});

test('audit measures a real approximation error when a different line becomes faster', () => {
  const { profile } = fixture({ phases: { n0: [0] } });
  const alternate = structuredClone(profile.routes[0]);
  alternate.id = 'alternate';
  alternate.departureAnchorsByNode = { n0: [180] };
  profile.routes.push(alternate);
  profile.activeRouteIds.push(alternate.id);
  const router = createCrossTileRoutingCache().getRouter({ A: profile });
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes), { auditEvery: 1 });
  const initial = reuse.search(router, queryFor(router, { requestedDepartureSeconds: 0 }));
  assert.equal(initial.edges[0].route.id, 'alternate');
  const audited = reuse.search(router, queryFor(router, { requestedDepartureSeconds: 181 }));
  assert.equal(audited.edges[0].route.id, 'r');
  assert.equal(reuse.stats.auditWorse, 1);
  assert.ok(reuse.stats.auditMaximumCostErrorSeconds > 70);
  assert.equal(reuse.stats.retainedEdges, 6, 'both distinct alternatives enter the bounded menu');
});

test('full journey materialization matches baseline on a single-route network', () => {
  const { profile, stations } = fixture();
  const input = { worldId: 'route-reuse-test', networkProfiles: { A: profile }, gatewayCatalog: {}, fare: 3,
    includeJourneyDetails: true, crossDemand: { schemaVersion: 1, tileId: 'A', gateways: ['local'],
      points: stations.map(s => [s.id, ...s.coords, 'A']),
      popFields: ['id', 'mass', 'home', 'work', 'gateway', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime'],
      pops: Array.from({ length: 30 }, (_, index) => [`p${index}`, 90 + index, 0, 3, 0, 1800, 16000, 1000 + index * 31]) } };
  const reuse = createRouteReuseSearch(createWasmTransitSearch(bytes));
  const baseline = calculateCrossTileModeShares({ ...input,
    routingCache: createCrossTileRoutingCache({ searchKernel: createWasmTransitSearch(bytes) }) });
  const actual = calculateCrossTileModeShares({ ...input,
    routingCache: createCrossTileRoutingCache({ searchKernel: reuse }) });
  const withoutStats = ({ routingStats, ...rest }) => rest;
  assert.deepEqual(withoutStats(actual), withoutStats(baseline));
  assert.ok(reuse.stats.hits > 0);
});
