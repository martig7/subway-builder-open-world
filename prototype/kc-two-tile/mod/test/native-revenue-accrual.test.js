import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeRevenueAccrual } from '../../../../open-world-platform/src/runtime/native-revenue-accrual.js';

function revenueProfile(tileId, revenue, revenueByRoute = {}) {
  return {
    schemaVersion: 3,
    tileId,
    hourly: Array.from({ length: 24 }, () => ({ revenue, revenueByRoute })),
    dailyRevenue: revenue * 24,
  };
}

function receiptAdapter() {
  const receipts = new Set();
  const postings = [];
  let balance = 100;
  return {
    postings,
    get balance() { return balance; },
    async postBackgroundNativeFinance(posting) {
      postings.push(structuredClone(posting));
      if (receipts.has(posting.postingId)) return { applied: false, wallet: balance };
      receipts.add(posting.postingId);
      balance += posting.revenue;
      return { applied: true, revenue: posting.revenue, wallet: balance };
    },
  };
}

test('posts only inactive-tile revenue through the injected adapter', async () => {
  const adapter = receiptAdapter();
  const accrual = new NativeRevenueAccrual({ adapter });
  accrual.replaceProfiles({
    networkHash: 'network-a',
    profiles: {
      A: revenueProfile('A', 10, { local: 10 }),
      B: revenueProfile('B', 20, { remote: 20 }),
    },
  });

  const result = await accrual.postHour({
    worldId: 'world-1',
    hour: 7,
    activeTileId: 'A',
    projection: { activeTileId: 'A' },
  });

  assert.deepEqual(result, {
    status: 'posted',
    postingId: 'native-revenue:v1:world-1:7',
    networkHash: 'network-a',
    hour: 7,
    calculatedRevenue: 20,
    postedRevenue: 20,
    wallet: 120,
  });
  assert.equal(adapter.postings.length, 1);
  assert.deepEqual(adapter.postings[0], {
    postingId: 'native-revenue:v1:world-1:7',
    targetElapsedSeconds: 25_200,
    revenue: 20,
    revenueByTile: { A: 0, B: 20 },
    revenueByRoute: { remote: 20 },
    completedCommutes: [],
    hourlyPostings: [{
      hour: 7,
      revenue: 20,
      revenueByTile: { A: 0, B: 20 },
      revenueByRoute: { remote: 20 },
    }],
  });
  for (const forbidden of ['expenses', 'expenseCategories', 'expensesByRoute']) {
    assert.equal(Object.hasOwn(adapter.postings[0], forbidden), false);
    assert.equal(Object.hasOwn(adapter.postings[0].hourlyPostings[0], forbidden), false);
  }
});

test('uses the native receipt result for idempotency across retries and profile changes', async () => {
  const adapter = receiptAdapter();
  const accrual = new NativeRevenueAccrual({ adapter });
  accrual.replaceProfiles({
    networkHash: 'network-a',
    profiles: { B: revenueProfile('B', 20) },
  });

  const first = await accrual.postHour({ worldId: 'world/1', hour: 8, activeTileId: 'A', projection: {} });
  accrual.replaceProfiles({
    networkHash: 'network-b',
    profiles: { B: revenueProfile('B', 999) },
  });
  const retry = await accrual.postHour({ worldId: 'world/1', hour: 8, activeTileId: 'A', projection: {} });

  assert.equal(first.status, 'posted');
  assert.equal(retry.status, 'already-posted');
  assert.equal(retry.postingId, first.postingId);
  assert.equal(retry.calculatedRevenue, 999);
  assert.equal(retry.postedRevenue, 0);
  assert.equal(adapter.balance, 120);
  assert.equal(adapter.postings.length, 2);
});

test('invalidate discards derived profiles and replacement snapshots caller data', async () => {
  const adapter = receiptAdapter();
  const accrual = new NativeRevenueAccrual({ adapter });
  const profiles = { B: revenueProfile('B', 15) };
  accrual.replaceProfiles({ networkHash: 'network-a', profiles });
  profiles.B.hourly[9].revenue = 1_000;

  const posted = await accrual.postHour({ worldId: 'world-1', hour: 9, activeTileId: 'A', projection: {} });
  assert.equal(posted.calculatedRevenue, 15);

  accrual.invalidate();
  const skipped = await accrual.postHour({ worldId: 'world-1', hour: 10, activeTileId: 'A', projection: {} });
  assert.deepEqual(skipped, {
    status: 'profiles-unavailable',
    postingId: null,
    networkHash: null,
    hour: 10,
    calculatedRevenue: 0,
    postedRevenue: 0,
    wallet: null,
  });
  assert.equal(adapter.postings.length, 1);
});

test('a failed adapter post is retried with the same deterministic receipt', async () => {
  const postingIds = [];
  let attempts = 0;
  const accrual = new NativeRevenueAccrual({
    adapter: {
      async postBackgroundNativeFinance(posting) {
        postingIds.push(posting.postingId);
        attempts++;
        if (attempts === 1) throw new Error('native transaction failed');
        return { applied: true, revenue: posting.revenue, wallet: 12 };
      },
    },
  });
  accrual.replaceProfiles({ networkHash: 'network-a', profiles: { B: revenueProfile('B', 12) } });

  await assert.rejects(
    accrual.postHour({ worldId: 'world-1', hour: 11, activeTileId: 'A', projection: {} }),
    /native transaction failed/,
  );
  const result = await accrual.postHour({ worldId: 'world-1', hour: 11, activeTileId: 'A', projection: {} });

  assert.equal(result.status, 'posted');
  assert.deepEqual(postingIds, [
    'native-revenue:v1:world-1:11',
    'native-revenue:v1:world-1:11',
  ]);
});

test('rejects invalid interface inputs before reaching the adapter', async () => {
  assert.throws(() => new NativeRevenueAccrual({ adapter: {} }), /postBackgroundNativeFinance/);
  const adapter = receiptAdapter();
  const accrual = new NativeRevenueAccrual({ adapter });
  assert.throws(() => accrual.replaceProfiles({ networkHash: '', profiles: {} }), /networkHash/);
  assert.throws(() => accrual.replaceProfiles({ networkHash: 'a', profiles: [] }), /profiles/);
  accrual.replaceProfiles({ networkHash: 'a', profiles: {} });
  await assert.rejects(
    accrual.postHour({ worldId: '', hour: 1, activeTileId: 'A', projection: {} }),
    /worldId/,
  );
  await assert.rejects(
    accrual.postHour({ worldId: 'world', hour: 1.5, activeTileId: 'A', projection: {} }),
    /hour/,
  );
});

test('free inactive ridership still receives a native settlement receipt', async () => {
  const adapter = receiptAdapter(); const accrual = new NativeRevenueAccrual({adapter});
  const profile = revenueProfile('B',0);
  profile.hourly[7].completedCommutes=[{popId:'p',size:3,stationRoutes:[{routeId:'r',stationIds:['s','t']}],journeyStart:25200,journeyEnd:25500,origin:'home'}];
  accrual.replaceProfiles({networkHash:'n',profiles:{B:profile}});
  const args={worldId:'w',hour:7,activeTileId:'A',projection:{activeTileId:'A'}};
  assert.equal((await accrual.postHour(args)).status,'posted');
  assert.equal((await accrual.postHour(args)).status,'already-posted');
  assert.equal(adapter.postings[0].completedCommutes[0].size,3);
  assert.equal(adapter.balance,100);
});
