import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillHourlyFinancialHistory, backfillHourlyRouteFinancials } from '../src/runtime/native-finance-model.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function ledgers() {
  return {
    history: { entries: [0,1,2].map(hour => ({ timestamp: hour * 3600, balance: 100 + hour,
      hourlyRevenue: 5, hourlyExpenses: 1, expenseCategories: { trainOperational: 1 } })),
      lastHourTimestamp: 10800, currentHourRevenue: 7, currentHourExpenses: 2, currentHourExpenseCategories: { trainOperational: 2 } },
    routes: { byRoute: { r: [0,1,2].map(hour => ({ timestamp: hour * 3600, revenue: 5, expenses: 1 })) },
      lastHourTimestamp: 10800, currentHour: { r: { revenue: 7, expenses: 2 } } },
  };
}

test('current-hour postings preserve closed history references without changing native input', () => {
  const { history, routes } = freeze(ledgers());
  const rows = [{ hour: 3, revenue: 10, expenses: 2, expenseCategories: { trainOperational: 2 }, revenueByRoute: { r: 10 }, expensesByRoute: { r: 2 } }];
  const options = { targetElapsedSeconds: 10800, openingWallet: 100, receiptId: 'one' };
  const h = backfillHourlyFinancialHistory(history, rows, { ...options, copy: 'on-write' });
  const r = backfillHourlyRouteFinancials(routes, rows, 10800, { copy: 'on-write' });
  assert.deepEqual(h, backfillHourlyFinancialHistory(history, rows, options));
  assert.deepEqual(r, backfillHourlyRouteFinancials(routes, rows, 10800));
  assert.strictEqual(h.entries, history.entries);
  assert.strictEqual(r.byRoute.r, routes.byRoute.r);
  assert.notStrictEqual(h.currentHourExpenseCategories, history.currentHourExpenseCategories);
  assert.notStrictEqual(r.currentHour.r, routes.currentHour.r);
});

test('copy-on-write matches detached backfill for delayed hours, rollover, retries and rewind', () => {
  for (const expensesAffectWallet of [true, false]) {
    let { history, routes } = ledgers();
    const cases = [
      { target: 3, hours: [1,3], id: 'late' },
      { target: 3, hours: [1,3], id: 'late' },
      { target: 8, hours: [4,6,8], id: 'catchup' },
      { target: 3, hours: [3], id: 'rewind' },
      { target: 9, hours: [9], id: 'next' },
    ];
    for (const c of cases) {
      freeze(history); freeze(routes);
      const rows = c.hours.map(hour => ({ hour, postingId: `${c.id}:${hour}`, revenue: 10, expenses: 2,
        expenseCategories: { trainOperational: 2 }, revenueByRoute: { r: 10, new: 3 }, expensesByRoute: { r: 2 } }));
      const options = { targetElapsedSeconds: c.target * 3600, openingWallet: 500, expensesAffectWallet, receiptId: c.id };
      const expectedH = backfillHourlyFinancialHistory(history, rows, options);
      const expectedR = backfillHourlyRouteFinancials(routes, rows, options.targetElapsedSeconds);
      history = backfillHourlyFinancialHistory(history, rows, { ...options, copy: 'on-write' });
      routes = backfillHourlyRouteFinancials(routes, rows, options.targetElapsedSeconds, { copy: 'on-write' });
      assert.deepEqual(history, expectedH, c.id);
      assert.deepEqual(routes, expectedR, c.id);
    }
  }
});

test('routine native balance reads and fare receipts can omit history while default reads stay detached', async () => {
  const { history } = ledgers();
  let historyReads = 0;
  const state = { money: 100, timeConfig: { elapsedSeconds: 10800 }, routes: [], completedCommutes: [],
    get financialHistory() { historyReads++; return history; } };
  const adapter = new SubwayBuilderGameAdapter({ api: {}, callbacks: { getState: () => state } });
  adapter.assertSupported = async () => {};
  const globals = await adapter.captureAuthoritativeGlobals({ includeFinancialHistory: false });
  const receipt = await adapter.creditCrossTileFareRevenue(0, {}, { includeFinancialHistory: false });
  assert.equal(historyReads, 0, 'no native history read for balance-only consumers');
  assert.equal(globals.financialHistory, undefined);
  assert.equal(receipt.financialHistory, undefined);
  const full = await adapter.captureAuthoritativeGlobals();
  assert.deepEqual(full.financialHistory, history);
  assert.notStrictEqual(full.financialHistory.entries[0], history.entries[0]);
});

test('posting a large closed ledger does not enumerate or clone untouched row payloads', () => {
  const { history, routes } = ledgers();
  let payloadReads = 0;
  history.entries = Array.from({ length: 10000 }, (_, hour) => ({ timestamp: hour * 3600, balance: 100,
    hourlyRevenue: 5, hourlyExpenses: 1, get expenseCategories() { payloadReads++; return { trainOperational: 1 }; } }));
  history.lastHourTimestamp = 10000 * 3600;
  const state = { money: 100, gameSessionId: 'large', timeConfig: { elapsedSeconds: history.lastHourTimestamp },
    routes: [], completedCommutes: [], financialHistory: history, routeFinancials: routes,
    addRevenue(n) { this.money += n; this.financialHistory.currentHourRevenue += n; },
    setFinancialHistory(value) { this.financialHistory = value; } };
  const adapter = new SubwayBuilderGameAdapter({ api: {}, callbacks: { getState: () => state } });
  adapter.postBackgroundNativeFinanceNow({ postingId: 'large-current', revenue: 10,
    targetElapsedSeconds: history.lastHourTimestamp }, { includeFinancialHistory: false });
  assert.equal(payloadReads, 0);
  assert.strictEqual(state.financialHistory.entries, history.entries);
  assert.equal(state.financialHistory.currentHourRevenue, 17);
});

test('copy-on-write normalizes unsorted and malformed legacy balances like detached backfill', () => {
  const { history } = ledgers();
  history.entries.reverse(); history.entries[0].balance = '123'; history.entries[1].balance = -0;
  freeze(history);
  const options = { targetElapsedSeconds: history.lastHourTimestamp, openingWallet: 100 };
  assert.deepEqual(backfillHourlyFinancialHistory(history, [], { ...options, copy: 'on-write' }),
    backfillHourlyFinancialHistory(history, [], options));
});
