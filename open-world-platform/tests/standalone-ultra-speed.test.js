import test from 'node:test';
import assert from 'node:assert/strict';
import { startUltraSpeed, ULTRA_SPEED_MOD_ID } from '../src/runtime/start-ultra-speed.js';
import { registerWorldUltraSpeedOwner, ultraSpeedWorldOwner } from '../src/runtime/ultra-speed-ownership.js';
import { createSubwayBuilderHostState } from '../testkit/subway-builder-host.js';

function fixture() {
  let nativeTicks = 0;
  const state = createSubwayBuilderHostState({ cityCode: 'NATIVE', gameSessionId: 'one', money: 10000, transitCost: 2,
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    tracks: [{ id: 'track', buildType: 'constructed', trackType: 'heavy-metro', length: 1000 }],
    trackGroups: [{ id: 'group', trackType: 'heavy-metro', trackIds: ['track'] }],
    lastInfrastructureChargeTime: 25000,
    timeConfig: { elapsedSeconds: 25000, paused: false, timeSpeed: 'ultrafast' },
    demandData: { points: new Map([['home', { id: 'home', location: [0, 0] }], ['work', { id: 'work', location: [0.001, 0] }]]),
      popsMap: new Map([['p', { id: 'p', size: 10, residenceId: 'home', jobId: 'work', drivingSeconds: 600, drivingDistance: 1000,
        homeDepartureTime: 25000, workDepartureTime: 64000 }]]) },
    setDemandData(value) { state.demandData = value; }, setTrains(value) { state.trains = value; },
    generateSave() { return { data: { elapsedSeconds: state.timeConfig.elapsedSeconds, trains: state.trains, money: state.money } }; },
    loadSave() {}, handleIncrementGameState() { nativeTicks++; },
  });
  const hooks = new Map(), panels = [], saved = new Map();
  const callbacks = { getState: () => state, setMoney() {}, setTicketCost() {} };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const api = { version: '1.0.0', cities: { setCityDataFiles() { throw new Error('Standalone must not register city data'); } },
    trains: { getTrainTypes: () => [] },
    gameState: { getStations: () => state.stations, getRoutes: () => state.routes, getTrains: () => state.trains },
    utils: { getPathfindingRules: () => ({}), React: { createElement: () => null } },
    hooks: new Proxy({}, { get: (_target, key) => listener => {
      const set = hooks.get(key) ?? new Set(); hooks.set(key, set); set.add(listener); return () => set.delete(listener);
    } }), ui: { addToolbarPanel: panel => panels.push(panel), unregisterComponent() {} } };
  return { api, callbacks, storage, state, saved, panels, nativeTicks: () => nativeTicks,
    async emit(name) { await Promise.all([...(hooks.get(name) ?? [])].map(listener => listener())); } };
}

async function withMod(run) {
  const f = fixture(); let mod;
  try { mod = await startUltraSpeed(f); await run(f, mod); }
  finally { await globalThis.__subwayBuilderUltraSpeedModV1__?.dispose(); delete globalThis.__openWorldUltraSpeedOwnershipV1__; }
}

test('native city uses shared cached ticks, pause, synchronous saves and midnight invalidation without a server', async () => {
  await withMod(async (f, mod) => {
    assert.equal(mod.snapshot().enabled, false);
    assert.equal(f.panels[0].title, 'Ultra speed');
    await f.state.handleIncrementGameState(); assert.equal(f.nativeTicks(), 1);
    await mod.setEnabled(true);
    assert.equal(mod.snapshot().error, null); assert.equal(mod.snapshot().assignedPops, 1);
    const before = f.state.timeConfig.elapsedSeconds;
    await f.state.handleIncrementGameState(); assert.equal(f.state.timeConfig.elapsedSeconds, before + 240);
    assert.equal(f.nativeTicks(), 1);
    f.state.setTimeConfig({ paused: true }); await f.state.handleIncrementGameState();
    assert.equal(f.state.timeConfig.elapsedSeconds, before + 240);
    const save = f.state.generateSave(); assert.equal(typeof save.then, 'undefined'); assert.equal(save.data.money, f.state.money);
    assert.ok(f.state.money < 10000, 'native ledger receives nonzero estimated infrastructure costs');
    await f.emit('onTicketPriceChanged'); assert.equal(mod.snapshot().pendingMidnightRefresh, true);
    f.state.setTimeConfig({ paused: false, elapsedSeconds: 86390 }); await f.state.handleIncrementGameState();
    assert.equal(f.state.timeConfig.elapsedSeconds, 86400); assert.equal(mod.snapshot().pendingMidnightRefresh, false);
    await mod.setEnabled(false); await f.state.handleIncrementGameState(); assert.equal(f.nativeTicks(), 2);
    assert.equal(JSON.parse([...f.saved.values()][0]).ultraHighSpeed, false);
  });
});

test('preference survives save replacement and game end while old wrappers and assignments are retired', async () => {
  await withMod(async (f, mod) => {
    await mod.setEnabled(true); const oldWrapper = f.state.handleIncrementGameState;
    f.state.gameSessionId = 'two'; await f.emit('onGameLoaded');
    assert.equal(mod.snapshot().enabled, true); assert.equal(mod.snapshot().assignedPops, 1);
    assert.notEqual(f.state.handleIncrementGameState, oldWrapper);
    await f.emit('onGameEnd'); assert.equal(mod.snapshot().status, 'unavailable');
    await f.state.handleIncrementGameState(); assert.equal(f.nativeTicks(), 1);
    assert.equal(JSON.parse(f.saved.get(`open-world:mode-preferences-v1:${ULTRA_SPEED_MOD_ID}`)).ultraHighSpeed, true);
    await f.emit('onGameInit'); assert.equal(mod.snapshot().status, 'ready');
  });
});

test('both load orders yield to Open World cities without changing either preference or taking its wrappers', async () => {
  for (const worldFirst of [true, false]) await withMod(async (f, initial) => {
    let mod = initial;
    await mod.setEnabled(true);
    let release;
    if (worldFirst) {
      await mod.dispose();
      release = registerWorldUltraSpeedOwner('local.world', ['NATIVE']);
      mod = await startUltraSpeed(f);
    } else {
      release = registerWorldUltraSpeedOwner('local.world', ['NATIVE']);
      await mod.whenIdle();
    }
    assert.equal(mod.snapshot().status, 'open-world');
    assert.equal(ultraSpeedWorldOwner('NATIVE'), 'local.world');
    const native = f.state.handleIncrementGameState;
    const worldWrapper = () => 'world owns the tick'; f.state.handleIncrementGameState = worldWrapper;
    await mod.setEnabled(false); assert.equal(f.state.handleIncrementGameState, worldWrapper);
    assert.equal(JSON.parse([...f.saved.values()][0]).ultraHighSpeed, true);
    f.state.handleIncrementGameState = native;
    release(); await mod.whenIdle(); assert.equal(mod.snapshot().status, 'ready');
    assert.equal(mod.snapshot().assignedPops, 1);
  });
});

test('hot reload removes previous subscriptions and replaces wrappers without changing enabled intent', async () => {
  await withMod(async (f, previous) => {
    await previous.setEnabled(true); const old = f.state.handleIncrementGameState;
    const next = await startUltraSpeed(f);
    assert.notEqual(f.state.handleIncrementGameState, old); assert.equal(next.snapshot().status, 'ready');
    const count = next.snapshot().calculations;
    await f.emit('onGameLoaded'); assert.equal(next.snapshot().calculations, 1);
    assert.equal(count, 1); await next.dispose(); await next.dispose();
  });
});

test('World ownership leases from an older reload cannot release the replacement', () => {
  const old = registerWorldUltraSpeedOwner('world', ['A']);
  const current = registerWorldUltraSpeedOwner('world', ['B']);
  old(); assert.equal(ultraSpeedWorldOwner('B'), 'world'); assert.equal(ultraSpeedWorldOwner('A'), null);
  current(); assert.equal(ultraSpeedWorldOwner('B'), null); delete globalThis.__openWorldUltraSpeedOwnershipV1__;
});


test('turning off during native work drainage cancels the pending enable request', async () => {
  await withMod(async (f, mod) => {
    let finish;
    // Reattach to observe this async action as the real game launches a wave.
    f.state.simulateCommutes = () => new Promise(resolve => { finish = resolve; });
    await f.emit('onGameLoaded');
    const native = f.state.simulateCommutes();
    const enabling = mod.setEnabled(true);
    await new Promise(resolve => setImmediate(resolve));
    const disabling = mod.setEnabled(false);
    finish(); await Promise.all([native, enabling, disabling]);
    assert.equal(mod.snapshot().enabled, false); assert.equal(mod.snapshot().calculations, 0);
  });
});


test('a dormant World for a different city reserves its retained native controller', async () => {
  await withMod(async (f, mod) => {
    await mod.setEnabled(true);
    const release = registerWorldUltraSpeedOwner('local.different-world', ['OTHER_CITY']);
    await mod.whenIdle();
    assert.equal(mod.snapshot().status, 'open-world');
    assert.equal(mod.snapshot().worldOwner, 'local.different-world');
    await f.state.handleIncrementGameState(); assert.equal(f.nativeTicks(), 1);
    release(); await mod.whenIdle(); assert.equal(mod.snapshot().status, 'ready');
  });
});
