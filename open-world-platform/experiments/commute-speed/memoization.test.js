import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEvaluationMemo, withEvaluationMemo, evaluationGraphKey, evaluationFareIndex } from './memoization.js';

const fareSource = await readFile(new URL('../../src/runtime/journey-fare.js', import.meta.url), 'utf8');
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const original = await load(fareSource + '\nexport { fareIndex };');
const wrapped = await load(`import { evaluationFareIndex } from '${new URL('./memoization.js', import.meta.url).href}';\n`
  + fareSource.replace('function fareIndex(fareGroups, routes, legacyFare)', 'function uncachedFareIndex(fareGroups, routes, legacyFare)')
  + '\nfunction fareIndex(groups, routes, fare) { return evaluationFareIndex(groups, routes, fare, uncachedFareIndex); }');
const graphKey = input => JSON.stringify(Object.entries(input ?? {}).filter(([, p]) => p).sort(([a], [b]) => a.localeCompare(b)));

test('graph serialization matches the exact source key with reordered wrappers and changed snapshots', () => {
  const memo = createEvaluationMemo();
  const a = { routes: [{ id: 'r1', serviceCount: 5 }], stations: [{ id: 's1' }] };
  const b = { routes: [{ id: 'r2', serviceCount: 7 }], stations: [{ id: 's2' }] };
  const first = { B: b, A: a, empty: null };
  assert.equal(memo.graphKey(first), graphKey(first));
  assert.equal(memo.graphKey({ A: a, B: b, removed: false }), graphKey(first));
  assert.equal(memo.stats.graphHits, 1);
  assert.equal(memo.stats.graphSerializations, 1);
  const changed = { A: { ...a, routes: [{ id: 'r1', serviceCount: 8 }] }, B: b };
  assert.equal(memo.graphKey(changed), graphKey(changed));
  assert.equal(memo.stats.graphSerializations, 2);
  assert.equal(memo.graphKey(null), '[]');
  assert.equal(memo.stats.retainedGraphSnapshots, 1);
  memo.clear();
  assert.equal(memo.stats.retainedGraphSnapshots, 0);
  assert.equal(memo.stats.graphKeyBytes, 0);
  a.routes[0].serviceCount = 12;
  assert.equal(memo.graphKey(first), graphKey(first), 'clear must permit same-object edits between jobs');
});

test('scoped fare index produces exact quotes across normal fare systems and temporary routes', () => {
  const routes = [{ id: 'a' }, { id: 'b' }, { id: 'temp', tempParentId: 'a' }];
  const segments = [
    { routeId: 'temp', fromStopCoords: [139, 35], toStopCoords: [139.05, 35.01] },
    { routeId: 'b', fromStopCoords: [139.05, 35.01], toStopCoords: [139.09, 35.02] },
    { routeId: 'walking', isWalking: true },
  ];
  let captured;
  withEvaluationMemo(memo => {
    captured = memo;
    for (const fareSystem of ['flat', 'route', 'distance']) {
      for (const transferPolicy of ['free-within-group', 'count-within-group', 'all-paid', 'count-all-groups']) {
        const fareGroups = [{ id: 'g', routeIds: ['a', 'b'], fareSystem, flatFare: 3,
          routeFares: { a: 2, b: 4 }, transferPolicy, boardingCharge: 1.5, perKmRate: 0.2, fareCap: 5 }];
        const args = { segments, fareGroups, routes, legacyFare: 2 };
        assert.deepEqual(wrapped.quoteJourneyFare(args), original.quoteJourneyFare(args));
        assert.deepEqual(wrapped.quoteJourneyFare(args), original.quoteJourneyFare(args));
      }
    }
    assert.equal(memo.stats.fareBuilds, 12);
    assert.equal(memo.stats.fareHits, 12);
    assert.equal(memo.stats.retainedFareIndexes, 1);
    assert.equal(memo.stats.peakFareEntries, 3);
  });
  assert.equal(captured.stats.retainedFareIndexes, 0);
  assert.equal(captured.stats.fareEntries, 0);
});

test('fresh scopes observe same-object edits and inactive calls retain no cache', () => {
  const profile = { routes: [{ id: 'r', serviceCount: 2 }] };
  const groups = [{ id: 'g', routeIds: ['r'], flatFare: 3 }], routes = [{ id: 'r' }];
  const snapshot = () => withEvaluationMemo(() => ({ key: evaluationGraphKey({ A: profile }),
    fare: evaluationFareIndex(groups, routes, 1, original.fareIndex).get('r').fare }));
  const before = snapshot();
  profile.routes[0].serviceCount = 9; groups[0].flatFare = 7;
  const after = snapshot();
  assert.notEqual(after.key, before.key);
  assert.equal(after.key, graphKey({ A: profile }));
  assert.equal(after.fare, 7);
  groups[0].flatFare = 11;
  assert.equal(evaluationFareIndex(groups, routes, 1, original.fareIndex).get('r').fare, 11);
  assert.notEqual(evaluationFareIndex(groups, routes, 1, original.fareIndex),
    evaluationFareIndex(groups, routes, 1, original.fareIndex));
});

test('last-value caches are bounded and scope cleanup runs after failures or nested evaluation', () => {
  const memo = createEvaluationMemo();
  const routes = [{ id: 'r' }], a = [{ id: 'g', routeIds: ['r'], flatFare: 3 }], b = [];
  memo.fareIndex(a, routes, 1, original.fareIndex);
  memo.fareIndex(b, routes, 1, original.fareIndex);
  memo.fareIndex(a, routes, 1, original.fareIndex);
  assert.equal(memo.stats.fareBuilds, 3);
  assert.equal(memo.stats.retainedFareIndexes, 1);
  let captured;
  assert.throws(() => withEvaluationMemo(current => {
    captured = current;
    evaluationGraphKey({ A: routes });
    evaluationFareIndex(a, routes, 1, original.fareIndex);
    throw new Error('abort evaluation');
  }), /abort evaluation/);
  assert.equal(captured.stats.retainedGraphSnapshots, 0);
  assert.equal(captured.stats.retainedFareIndexes, 0);
  withEvaluationMemo(outer => {
    evaluationGraphKey({ A: routes });
    withEvaluationMemo(inner => {
      evaluationGraphKey({ B: routes });
      assert.equal(inner.stats.graphSerializations, 1);
    });
    evaluationGraphKey({ A: routes });
    assert.equal(outer.stats.graphHits, 1);
  });
  assert.throws(() => withEvaluationMemo(() => Promise.resolve()), /synchronous/);
});
