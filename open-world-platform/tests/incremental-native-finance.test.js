import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';

function fixture() {
  const state = { gameSessionId: 'one', timeConfig: { elapsedSeconds: 3600 }, money: 100, routes: [{ id: 'r' }],
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    routeFinancials: { byRoute: {}, currentHour: {}, lastHourTimestamp: 0 }, completedCommutes: [],
    addRevenue(n) { this.money += n; this.financialHistory.currentHourRevenue += n; },
    addExpense(n, category) { this.money -= n; this.financialHistory.currentHourExpenses += n; this.financialHistory.currentHourExpenseCategories[category] = (this.financialHistory.currentHourExpenseCategories[category] ?? 0) + n; },
    setFinancialHistory(v) { this.financialHistory = v; }, setRouteFinancials(v) { this.routeFinancials = v; },
    setCompletedCommutes(v) { this.completedCommutes = v; },
  };
  const adapter = new SubwayBuilderGameAdapter({ api: {}, callbacks: { getState: () => state, setMoney: n => { state.money = n; } } });
  const post = (id, records = [], extra = {}) => adapter.postBackgroundNativeFinanceNow({ postingId: id, targetElapsedSeconds: state.timeConfig.elapsedSeconds,
    revenue: 10, revenueByRoute: { r: 10 }, expensesByRoute: { r: 2 }, expenseCategories: { trainOperational: 2 }, completedCommutes: records, ...extra }, { includeFinancialHistory: false });
  return { state, adapter, post };
}
const commute = (id, end, size = 1) => ({ popId: id, journeyEnd: end, journeyStart: end - 60, size, origin: 'home', stationRoutes: [{ routeId: 'r', stationIds: ['a','b'] }] });

test('look-ahead preparation yields without publishing and commits synchronously once', async () => {
  const f = fixture(); let yields = 0;
  const posting = { postingId: 'ahead', targetElapsedSeconds: 7200, revenue: 10,
    completedCommutes: Array.from({ length: 50 }, (_, i) => commute(String(i), 7200)) };
  const options = { includeFinancialHistory: false };
  await f.adapter.prepareBackgroundNativeFinance(posting, options, { budgetMs: 0, yieldTask: async () => {
    yields++; assert.equal(f.state.money, 100); assert.equal(f.state.completedCommutes.length, 0);
  } });
  assert.ok(yields > 50);
  f.state.timeConfig.elapsedSeconds = 7200;
  const result = f.adapter.postBackgroundNativeFinanceNow(posting, options);
  assert.equal(result.wallet, 110); assert.equal(result.then, undefined);
  assert.equal(f.state.completedCommutes.length, 50);
  assert.equal(f.adapter.nativeFinancePreparationStats.hits, 1);
  assert.equal(f.adapter.postBackgroundNativeFinanceNow(posting, options).applied, false);
});

test('prepared postings reject ledger replacement, clock rewind, session change and competing receipt', async () => {
  for (const edit of [
    f => { f.state.completedCommutes = [commute('native', 3600)]; },
    f => { f.state.gameSessionId = 'new'; f.state.money = 200; },
    f => { f.state.timeConfig.elapsedSeconds = 100; },
    f => { f.state.financialHistory = structuredClone(f.state.financialHistory); },
    f => { f.state.financialHistory.openWorldBackgroundFinanceReceipts = ['ahead']; },
  ]) {
    const f = fixture(), options = { includeFinancialHistory: false };
    const posting = { postingId: 'ahead', targetElapsedSeconds: 3600, revenue: 10 };
    await f.adapter.prepareBackgroundNativeFinance(posting, options);
    edit(f); const money = f.state.money;
    const duplicate = f.state.financialHistory.openWorldBackgroundFinanceReceipts?.includes('ahead');
    f.adapter.postBackgroundNativeFinanceNow(posting, options);
    assert.equal(f.adapter.nativeFinancePreparationStats.hits, 0);
    assert.equal(f.state.money, money + (duplicate ? 0 : 10));
  }
});

test('in-place native accounting during preparation invalidates the speculative ledger', async () => {
  const f = fixture(); let edited = false;
  f.state.financialHistory.lastHourTimestamp = 3600;
  const posting = { postingId: 'stale', targetElapsedSeconds: 3600, revenue: 10 };
  const options = { includeFinancialHistory: false };
  await f.adapter.prepareBackgroundNativeFinance(posting, options, { budgetMs: 0, yieldTask: async () => {
    if (!edited) { edited = true; f.state.addRevenue(7); }
  } });
  f.adapter.postBackgroundNativeFinanceNow(posting, options);
  assert.equal(f.state.money, 117);
  assert.equal(f.state.financialHistory.currentHourRevenue, 17);
});

test('hourly posting copies each native history once and can return just its receipt', () => {
  const f = fixture(); let copies = 0; const clone = globalThis.structuredClone;
  globalThis.structuredClone = value => { if (value && ('entries' in value || 'byRoute' in value) && 'lastHourTimestamp' in value) copies++; return clone(value); };
  try {
    const result = f.post('first');
    assert.equal(copies, 2, 'one defensive opening copy per native ledger');
    assert.equal(result.financialHistory, undefined);
    assert.equal(result.wallet, 108);
    assert.equal(f.state.financialHistory.currentHourRevenue, 10);
    assert.equal(f.state.routeFinancials.currentHour.r.revenue, 10);
    const duplicate = f.post('first');
    assert.equal(duplicate.applied, false);
    assert.equal(copies, 2, 'duplicate receipt needs no history copies');
  } finally { globalThis.structuredClone = clone; }
});

test('owned commute updates do not reread existing IDs and expire exact partial-hour boundaries', () => {
  const f = fixture(); let reads = 0;
  f.state.completedCommutes = Array.from({ length: 1000 }, (_, i) => {
    const c = commute('old-' + i, 1000); Object.defineProperty(c, 'popId', { get() { reads++; return 'old-' + i; }, enumerable: true }); return c;
  });
  f.post('first', [commute('new', 4000)]);
  reads = 0;
  f.post('second', [commute('new',4000), commute('next',4001)]);
  assert.equal(reads, 0, 'stable native array must reuse its index');
  assert.equal(f.state.completedCommutes.length, 1002);
  f.post('expiry', [], { retainCommutesSince: 4001 });
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['next']);
});

test('native array replacement, append and save-session changes rebuild the commute index', () => {
  const f = fixture(); f.post('one', [commute('a',3600)]);
  f.state.completedCommutes = [commute('b',3600)];
  f.post('two', [commute('a',3600),commute('b',3600)]);
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['b','a']);
  f.state.completedCommutes.push(commute('native',3600));
  f.post('three', [commute('native',3600)]);
  assert.equal(f.state.completedCommutes.length, 3);
  f.state.gameSessionId = 'two'; f.state.completedCommutes = [];
  f.post('four', [commute('a',3600)]);
  assert.equal(f.state.completedCommutes.length, 1);
});

test('existing duplicate IDs, out-of-order ends and unknown ends retain native order and exact cutoff', () => {
  const f = fixture(); f.state.completedCommutes = [commute('same',100),commute('later',500),commute('same',400),commute('unknown',NaN)];
  f.post('one', [commute('same',600)], { retainCommutesSince: 200 });
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['later','same']);
  f.post('two', [commute('same',600)], { retainCommutesSince: 450 });
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['later','same']);
  assert.equal(f.state.completedCommutes[1].journeyEnd, 600);
});

test('failed native publication and clock rewind cannot leave a stale commute index', () => {
  const f = fixture(); f.post('one', [commute('a',3600)]);
  const setter = f.state.setCompletedCommutes; f.state.setCompletedCommutes = () => { throw Error('publish failed'); };
  assert.throws(()=>f.post('two', [commute('b',3600)]), /publish failed/);
  f.state.setCompletedCommutes = setter;
  f.post('three', [commute('b',3600)]);
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['a','b']);
  f.state.timeConfig.elapsedSeconds = 100;
  f.state.completedCommutes = [commute('rewound',100)];
  f.post('four', [commute('a',100)]);
  assert.deepEqual(f.state.completedCommutes.map(c=>c.popId), ['rewound','a']);
});

test('cross-tile fare and cached posting share the index without rereading retained records', async () => {
  const f = fixture(); f.adapter.assertSupported = async () => {};
  f.state.recordRouteFinancials = () => {};
  let reads = 0; const existing = commute('old',3600);
  Object.defineProperty(existing, 'popId', { get() { reads++; return 'old'; }, enumerable: true });
  f.state.completedCommutes = [existing];
  f.post('first', [commute('native',3600)]); reads = 0;
  const cross = { ...commute('cross',3600), fareRevenue: 5, revenueByRoute: { r: 5 } };
  await f.adapter.creditCrossTileFareRevenue(5, { revenueByRoute: { r: 5 }, completedCommutes: [cross] });
  f.post('second', [commute('another',3600)]);
  assert.equal(reads, 0);
  const money = f.state.money;
  await f.adapter.creditCrossTileFareRevenue(5, { revenueByRoute: { r: 5 }, completedCommutes: [cross] });
  assert.equal(f.state.money, money);
  assert.equal(reads, 0);
});

test('cross-tile records without route attribution retain the native empty-segment shape', async () => {
  const f = fixture(); f.adapter.assertSupported = async () => {}; f.state.recordRouteFinancials = () => {};
  await f.adapter.creditCrossTileFareRevenue(0, { completedCommutes: [{ popId: 'no-route', journeyEnd: 3600, size: 1 }] });
  assert.deepEqual(f.state.completedCommutes[0].stationRoutes, []);
});
