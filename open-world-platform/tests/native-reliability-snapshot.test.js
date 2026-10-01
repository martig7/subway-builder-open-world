import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeTileRestoreSnapshot, SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { createSubwayBuilderHostState } from '../testkit/subway-builder-host.js';

test('template snapshots update native reliability without repeating demand compression', async () => {
  let generated = 0;
  const state = createSubwayBuilderHostState({
    cityCode: 'JP_TOKYO_MAINLAND', gameSessionId: 'session',
    reliabilityHistory: {
      lastHourTimestamp: 3600,
      currentHour: { R: { all: { count: 2, onTime: 1, delaySum: 12.4, addedSum: 5.6 } } },
      byRoute: { R: { all: [{ timestamp: 0, count: 3, onTime: 2, delaySum: 15, addedSum: 8 }] } },
    },
    generateSave() { generated++; throw new Error('demand must not be recompressed'); },
    loadSave() {},
  });
  const template = { cityCode: state.cityCode, data: {
    tracks: [], routes: [], trains: [], stations: [],
    reliabilityHistory: { v: 1, lastHourTimestamp: 0, currentHour: {}, byRoute: {} },
  } };
  const adapter = new SubwayBuilderGameAdapter({
    api: { version: '1.0.0', cities: { setCityDataFiles() {} } },
    callbacks: { getState: () => state, setMoney() {}, setTicketCost() {} },
  });
  const snapshot = await adapter.captureSnapshot(template);
  assert.equal(generated, 0);
  assert.deepEqual(snapshot.data.reliabilityHistory, {
    v: 1, lastHourTimestamp: 3600,
    currentHour: { R: { all: [2, 1, 12, 6] } },
    byRoute: { R: { all: [0, 3, 2, 15, 8] } },
  });
  state.reliabilityHistory.currentHour.R.all.count = 9;
  assert.equal(snapshot.data.reliabilityHistory.currentHour.R.all[0], 2);
  state.reliabilityHistory = { lastHourTimestamp: 7200, currentHour: {}, byRoute: {} };
  const empty = await adapter.captureSnapshot(snapshot);
  assert.equal(empty.data.reliabilityHistory, undefined, 'native empty history removes old saved stats');
  assert.equal(template.data.reliabilityHistory.lastHourTimestamp, 0);
});

test('tile restoration preserves the authoritative reliability field, including explicitly empty history', () => {
  const old = { v: 1, lastHourTimestamp: 0, currentHour: { R: { all: [1, 1, 0, 0] } }, byRoute: {} };
  const current = { lastHourTimestamp: 3600,
    currentHour: { R: { all: { count: 2, onTime: 1, delaySum: 1, addedSum: 2 } } }, byRoute: {} };
  const snapshot = { data: { reliabilityHistory: old } };
  const result = prepareNativeTileRestoreSnapshot(snapshot, {
    preserveNativeFinance: true, authoritativeFinanceState: { reliabilityHistory: current },
  });
  assert.deepEqual(result.data.reliabilityHistory.currentHour.R.all, [2, 1, 1, 2]);
  result.data.reliabilityHistory.currentHour.R.all[0] = 9;
  assert.equal(current.currentHour.R.all.count, 2);
  const empty = prepareNativeTileRestoreSnapshot(snapshot, {
    preserveNativeFinance: true, authoritativeFinanceState: { reliabilityHistory: undefined },
    fallbackState: { reliabilityHistory: current },
  });
  assert.equal(empty.data.reliabilityHistory, undefined);
  assert.equal(old.currentHour.R.all[0], 1);
});
