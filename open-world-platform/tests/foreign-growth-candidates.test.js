import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareForeignGrowthCandidates } from '../src/runtime/foreign-growth-candidates.js';
import { haversineMetres } from '../src/runtime/generated-road-routing.js';

function fixture(points, pops, ownerAt = point => point[0] >= 0 ? 'A' : 'B') {
  let loads = 0, ownershipQueries = 0;
  const ownership = { version: 1, key: 'original', ownerAt(point) { ownershipQueries++; return ownerAt(point); } };
  const tilePackages = { async loadCrossDemand(tileId) { loads++; assert.equal(tileId, 'A'); return { points, pops }; },
    loadNativeDemand() { assert.fail('foreign candidates cannot load inactive native demand'); } };
  return { ownership, tilePackages, stats: () => ({ loads, ownershipQueries }) };
}

test('foreign jobs are summed from work cohorts once and selected by true owner plus served walking access', async () => {
  const input = fixture([
    ['home', 0.001, 0, 'A', 99, 0], ['foreign', -0.001, 0, 'wrong-label', 99, 900],
    ['local', 0.002, 0, 'B', 0, 900], ['far', -1, 0, 'B', 0, 900], ['unowned', -0.003, 0, 'B', 0, 900],
  ], [['pop1', 7, 0, 1], ['pop2', 11, 0, 1], ['pop3', 12, 0, 2], ['pop4', 5, 0, 3], ['pop5', 2, 0, 4]],
  point => point[0] === -0.003 ? null : point[0] >= 0 ? 'A' : 'B');
  const handle = await prepareForeignGrowthCandidates({ ...input, tileId: 'A' });
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(input.stats(), { loads: 1, ownershipQueries: 4 });
  const result = handle.query({ tileId: 'A', stations: [{ coords: [0, 0], routeIds: ['served'], buildType: 'constructed' }], radiusM: 500 });
  assert.deepEqual(result, [{ id: 'foreign', location: [-0.001, 0], tileId: 'B', residents: 0, jobs: 18 }]);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(result[0].location), true);
  assert.deepEqual(handle.query({ tileId: 'A', stations: [{ location: [0, 0], routeIds: [] }], radiusM: 500 }), []);
  assert.deepEqual(handle.query({ tileId: 'A', stations: [{ location: [0, 0], served: false }], radiusM: 500 }), []);
  assert.deepEqual(handle.query({ tileId: 'A', stations: [[0, 0]], radiusM: 500 }), result);
  assert.deepEqual(input.stats(), { loads: 1, ownershipQueries: 4 }, 'queries must not reread geometry or packages');
  assert.throws(() => handle.query({ tileId: 'A', stations: [], radiusM: 500 }, { ...input.ownership, key: 'changed' }), /artifact changed/);
});

test('candidate catchment uses exact spherical distance across the dateline and high latitude', async () => {
  const points = [['foreign', -179.999, 70, 'B'], ['local', 179.998, 70, 'A'], ['far', -179.95, 70, 'B']];
  const input = fixture(points, [['p1', 3, 1, 0], ['p2', 4, 1, 2]], point => point[0] < 0 ? 'B' : 'A');
  const handle = await prepareForeignGrowthCandidates({ ...input, tileId: 'A' });
  const centre = [179.999, 70], radiusM = haversineMetres(centre, points[0].slice(1, 3));
  assert.deepEqual(handle.query({ tileId: 'A', stations: [centre], radiusM }).map(point => point.id), ['foreign']);
  assert.deepEqual(handle.query({ tileId: 'A', stations: [centre], radiusM: radiusM - 0.001 }), []);
  assert.deepEqual(handle.query({ tileId: 'A', stations: [centre, centre], radiusM }).map(point => point.id), ['foreign']);
});

test('output has a hard 2048 limit and deterministic nearest ordering despite input order', async () => {
  const points = Array.from({ length: 3000 }, (_, index) => [`id-${String(index).padStart(4, '0')}`, -0.001, 0, 'B']).reverse();
  const pops = points.map((_, index) => [`p${index}`, 1, 0, index]);
  const input = fixture(points, pops, () => 'B');
  const handle = await prepareForeignGrowthCandidates({ ...input, tileId: 'A' });
  const result = handle.query({ tileId: 'A', stations: [[0, 0]], radiusM: 500, limit: 10000 });
  assert.equal(result.length, 2048);
  assert.equal(result[0].id, 'id-0000');
  assert.equal(result.at(-1).id, 'id-2047');
  assert.equal(handle.query({ tileId: 'A', stations: [[0, 0]], radiusM: 500, limit: 2 }).length, 2);
});

test('field name mappings are respected instead of trusting packaged stock or tuple positions', async () => {
  const ownership = { version: 1, key: 'mapped', ownerAt: () => 'B' };
  const tilePackages = { async loadCrossDemand() { return {
    pointFields: ['latitude', 'id', 'longitude'], popFields: ['workPoint', 'id', 'mass'],
    points: [[0, 'job', -0.001]], pops: [[0, 'p', 12]],
  }; } };
  const handle = await prepareForeignGrowthCandidates({ tilePackages, tileId: 'A', ownership });
  assert.equal(handle.query({ tileId: 'A', stations: [[0, 0]], radiusM: 500 })[0].jobs, 12);
});

test('spherical index results match brute-force catchments over a deterministic worldwide catalog', async () => {
  let seed = 271828;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const points = Array.from({ length: 2000 }, (_, index) => [`job-${index}`, random() * 360 - 180, random() * 170 - 85, 'B']);
  const pops = points.map((_, index) => [`p${index}`, 1, 0, index]);
  const input = fixture(points, pops, () => 'B');
  const handle = await prepareForeignGrowthCandidates({ ...input, tileId: 'A' });
  for (let query = 0; query < 20; query++) {
    const stations = Array.from({ length: 3 }, () => [random() * 360 - 180, random() * 170 - 85]);
    const radiusM = random() * 3_000_000;
    const expected = points.map(point => ({ id: point[0], distance: Math.min(...stations.map(station => haversineMetres(station, point.slice(1, 3)))) }))
      .filter(point => point.distance <= radiusM).sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(point => point.id);
    assert.deepEqual(handle.query({ tileId: 'A', stations, radiusM }).map(point => point.id), expected);
  }
});

test('preparation checks cancellation after package awaits, during slices, and before publication', async () => {
  let cancelled = false, release;
  const ownership = { version: 1, key: 'cancel', ownerAt: () => 'B' };
  const pending = prepareForeignGrowthCandidates({ tileId: 'A', ownership, tilePackages: {
    loadCrossDemand: () => new Promise(resolve => { release = resolve; }),
  } }, { isCancelled: () => cancelled });
  cancelled = true; release({ points: [], pops: [] });
  assert.equal(await pending, null);
  cancelled = false;
  const input = fixture([['work', -0.001, 0, 'B']], [['p', 1, 0, 0]]);
  let clock = 0, yields = 0;
  assert.equal(await prepareForeignGrowthCandidates({ ...input, tileId: 'A' }, {
    sliceMs: 1, nowMs: () => clock++, isCancelled: () => cancelled,
    yieldFn: async () => { yields++; cancelled = true; },
  }), null);
  assert.equal(yields, 1);
  cancelled = false;
  assert.equal(await prepareForeignGrowthCandidates({ ...input, tileId: 'A' }, {
    sliceMs: Infinity, isCancelled: () => cancelled, onSlice: () => { cancelled = true; },
  }), null);
});
