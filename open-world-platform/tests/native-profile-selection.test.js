import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';

test('disabled native finance profiles never traverse their inputs', () => {
  const previous = globalThis.__subwayBuilder_storeCallbacks__;
  const state = { cityCode: 'A', timeConfig: { elapsedSeconds: 0 } };
  Object.defineProperty(state, 'demandData', { get() { throw new Error('read disabled revenue inputs'); } });
  const native = {};
  Object.defineProperty(native, 'tracks', { get() { throw new Error('read disabled expenses'); } });
  globalThis.__subwayBuilder_storeCallbacks__ = { getState: () => state };
  try {
    const game = new SubwayBuilderGameAdapter({ api: { trains: {
      getTrainTypes() { throw new Error('read disabled train types'); },
    } } });
    assert.deepEqual(game.calculateNativeFinanceProfile('A', native, {
      includeRevenue: false, includeExpenses: false,
    }), {});
    Object.defineProperty(native, 'routes', { value: [] });
    // Explicit inspection requests revenue without traversing native expenses.
    globalThis.__subwayBuilder_storeCallbacks__.getState = () => ({
      cityCode: 'A', timeConfig: state.timeConfig,
      demandData: { popsMap: new Map() }, routes: [], fareGroups: [], transitCost: 2.5,
    });
    const revenueOnly = game.calculateNativeFinanceProfile('A', native, { includeExpenses: false });
    assert.equal(revenueOnly.expenseProfile, undefined);
    assert.equal(revenueOnly.tileRevenueProfile.dailyRevenue, 0);
  } finally {
    if (previous === undefined) delete globalThis.__subwayBuilder_storeCallbacks__;
    else globalThis.__subwayBuilder_storeCallbacks__ = previous;
  }
});
