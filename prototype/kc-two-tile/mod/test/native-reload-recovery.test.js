import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_RELOAD_RECOVERY_VERSION,
  ORIGINAL_RELOAD_KEY,
  RECOVERY_METADATA_KEY,
  RELOAD_GUARD_KEY,
  createNativeTileRendererReload,
  installNativeReloadRecoveryGuard,
  stageNativeRecovery,
} from '../../../../open-world-platform/src/runtime/native-reload-recovery.js';

test('tile renderer reload updates both routes and bypasses the saved-file checkpoint wrapper', () => {
  const calls = [], state = { key: 'current-history' };
  const electron = {
    setCurrentRoute: route => calls.push(['main-route', route]),
    reloadWindow() { throw new Error('must not replace the staged handoff'); },
  };
  electron.reloadWindow[ORIGINAL_RELOAD_KEY] = function () {
    assert.equal(this, electron);
    calls.push(['reload']);
    return 'reloading';
  };
  const history = { state, replaceState: (...args) => calls.push(['history', ...args]) };
  const reload = createNativeTileRendererReload({ electron, history });
  assert.throws(() => reload({ route: '/game?city=NEXT' }), /staged native handoff/);
  assert.throws(() => reload({ route: '/menu', transitionId: 'handoff' }), /staged native handoff/);
  assert.deepEqual(calls, []);
  assert.equal(reload({ route: '/game?city=NEXT', transitionId: 'handoff' }), 'reloading');
  assert.deepEqual(calls, [
    ['history', state, '', '#/game?city=NEXT'], ['main-route', '/game?city=NEXT'], ['reload'],
  ]);
  assert.equal(createNativeTileRendererReload({ electron: {}, history }), null);
});

function nativeSave(cityCode = 'NEC_A') {
  return {
    id: 'save-1',
    name: 'Live game',
    cityCode,
    cityUid: cityCode,
    gameSessionId: 'world-1',
    metadata: { stations: 1, routes: 1, trains: 1 },
    data: {
      cityCode,
      cityUid: cityCode,
      tracks: [{ id: 'track-1' }],
      stations: [{ id: 'station-1' }],
      routes: [{ id: 'route-1' }],
      trains: [{ id: 'train-1' }],
      money: 12_345,
    },
  };
}

test('stages a city-bound native recovery save without mutating the live snapshot', async () => {
  const source = nativeSave('NEC_A');
  let pending = null;
  const electron = {
    setPendingSave: async (save) => { pending = structuredClone(save); return { success: true }; },
    getPendingSave: async () => ({ success: true, data: pending }),
    clearPendingSave: async () => { pending = null; },
  };

  const stage = await stageNativeRecovery({
    electron,
    snapshot: source,
    sourceCityCode: 'NEC_A',
    destinationCityCode: 'NEC_B',
    reason: 'tile-navigation',
    transitionId: 'world-1:NEC_A->NEC_B',
    now: () => 123,
    randomUUID: () => 'recovery-1',
  });

  assert.equal(source.cityCode, 'NEC_A');
  assert.equal(source.cityUid, 'NEC_A');
  assert.equal(source.data.cityCode, 'NEC_A');
  assert.equal(source.data.cityUid, 'NEC_A');
  assert.equal(pending.cityCode, 'NEC_B');
  assert.equal(pending.cityUid, 'NEC_B');
  assert.equal(pending.data.cityCode, 'NEC_B');
  assert.equal(pending.data.cityUid, 'NEC_B');
  assert.deepEqual(pending.data.routes, [{ id: 'route-1' }]);
  assert.deepEqual(pending.metadata[RECOVERY_METADATA_KEY], {
    schemaVersion: 1,
    recoveryId: 'recovery-1',
    reason: 'tile-navigation',
    transitionId: 'world-1:NEC_A->NEC_B',
    sourceCityCode: 'NEC_A',
    destinationCityCode: 'NEC_B',
    stagedAt: 123,
  });
  assert.equal(await stage.rollback(), true);
  assert.equal(pending, null);
});

test('reload guard restores the live native game after the base initializer clears it', async () => {
  let liveState = nativeSave().data;
  let pending = null;
  const calls = [];
  const electron = {
    getPendingSave: async () => ({ success: true, data: pending }),
    setPendingSave: async (save) => { calls.push('stage'); pending = structuredClone(save); return { success: true }; },
    reloadWindow() {
      calls.push('reload');
      liveState = { tracks: [], stations: [], routes: [], trains: [], money: 0 };
      if (pending) {
        liveState = structuredClone(pending.data);
        pending = null;
      }
    },
  };
  const globalObject = {};
  const guard = installNativeReloadRecoveryGuard({
    globalObject,
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => nativeSave(),
  });

  electron.reloadWindow();
  assert.deepEqual(calls, []);
  await guard.flush();

  assert.deepEqual(calls, ['stage', 'reload']);
  assert.deepEqual(liveState.routes, [{ id: 'route-1' }]);
  assert.equal(liveState.money, 12_345);
});

test('read-only Electron bridge falls back to a native recovery checkpoint without aborting mod startup', async () => {
  let pending = null;
  let liveState = nativeSave().data;
  const electron = {
    getPendingSave: async () => ({ success: true, data: pending }),
    setPendingSave: async (save) => { pending = structuredClone(save); return { success: true }; },
  };
  Object.defineProperty(electron, 'reloadWindow', {
    enumerable: true,
    value() {
      liveState = { tracks: [], stations: [], routes: [], trains: [], money: 0 };
      if (pending) {
        liveState = structuredClone(pending.data);
        pending = null;
      }
    },
    writable: false,
  });

  const guard = installNativeReloadRecoveryGuard({
    globalObject: {},
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => nativeSave(),
  });
  await guard.flush();

  assert.equal(guard.installed, true);
  assert.equal(guard.mode, 'checkpoint');
  electron.reloadWindow();
  assert.deepEqual(liveState.routes, [{ id: 'route-1' }]);
  assert.equal(liveState.money, 12_345);
  guard.dispose();
});

test('periodic recovery checkpoints reuse the prior native snapshot as a lightweight template', async () => {
  let pending = null;
  let intervalCallback = null;
  const templates = [];
  const electron = {
    getPendingSave: async () => ({ success: true, data: pending }),
    setPendingSave: async (save) => { pending = structuredClone(save); return { success: true }; },
  };
  Object.defineProperty(electron, 'reloadWindow', { value() {}, writable: false });

  const guard = installNativeReloadRecoveryGuard({
    globalObject: {},
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async (template = null) => {
      templates.push(template);
      return nativeSave();
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
  });
  await guard.flush();
  intervalCallback();
  await guard.flush();

  assert.equal(templates.length, 2);
  assert.equal(templates[0], null);
  assert.equal(templates[1]?.id, 'save-1');
  guard.dispose();
});

test('checkpoint fallback preserves an explicitly selected native save', async () => {
  const selected = nativeSave('NEC_B');
  let pending = selected;
  let captures = 0;
  const electron = {
    getPendingSave: async () => ({ success: true, data: pending }),
    setPendingSave: async (save) => { pending = save; return { success: true }; },
  };
  Object.defineProperty(electron, 'reloadWindow', {
    value() {},
    writable: false,
  });

  const guard = installNativeReloadRecoveryGuard({
    globalObject: {},
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => { captures += 1; return nativeSave(); },
  });
  await guard.flush();

  assert.equal(guard.mode, 'checkpoint');
  assert.equal(captures, 0);
  assert.equal(pending, selected);
  guard.dispose();
});

test('checkpoint fallback clears only its managed pending save when leaving gameplay', async () => {
  let pending = null;
  const listeners = new Map();
  const globalObject = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const electron = {
    getPendingSave: async () => ({ success: true, data: pending }),
    setPendingSave: async (save) => { pending = save; return { success: true }; },
    clearPendingSave: async () => { pending = null; },
  };
  Object.defineProperty(electron, 'reloadWindow', {
    value() {},
    writable: false,
  });
  const location = { hash: '#/game?city=NEC_A' };

  const guard = installNativeReloadRecoveryGuard({
    globalObject,
    electron,
    location,
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => nativeSave(),
  });
  await guard.flush();
  assert.ok(pending.metadata[RECOVERY_METADATA_KEY]);

  location.hash = '#/';
  await listeners.get('hashchange')();

  assert.equal(pending, null);
  guard.dispose();
  assert.equal(listeners.has('hashchange'), false);
});

test('reload guard preserves an explicitly staged native save', async () => {
  const selected = nativeSave('NEC_B');
  let captures = 0;
  let reloads = 0;
  const electron = {
    getPendingSave: async () => ({ success: true, data: selected }),
    setPendingSave: async () => { throw new Error('must not overwrite selected save'); },
    reloadWindow: () => { reloads += 1; },
  };
  const guard = installNativeReloadRecoveryGuard({
    globalObject: {},
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => { captures += 1; return nativeSave(); },
  });

  electron.reloadWindow();
  await guard.flush();

  assert.equal(captures, 0);
  assert.equal(reloads, 1);
});

for (const interruptedStage of ['capture', 'stage']) {
  test(`leaving gameplay during recovery ${interruptedStage} cannot leave a stale pending save`, async () => {
    let pending = null;
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const listeners = new Map();
    const location = { hash: '#/game' };
    const electron = {
      getPendingSave: async () => ({ success: true, data: pending }),
      setPendingSave: async save => {
        if (interruptedStage === 'stage') { entered(); await gate; }
        pending = save;
        return { success: true };
      },
      clearPendingSave: async () => { pending = null; },
    };
    Object.defineProperty(electron, 'reloadWindow', { value() {}, writable: false });
    const guard = installNativeReloadRecoveryGuard({
      globalObject: {
        addEventListener: (type, callback) => listeners.set(type, callback),
        removeEventListener: type => listeners.delete(type),
      },
      electron, location, checkpointIntervalMs: 0,
      getCityCode: () => 'NEC_A',
      captureSnapshot: async () => {
        if (interruptedStage === 'capture') { entered(); await gate; }
        return nativeSave();
      },
    });
    await started;
    location.hash = '#/';
    await listeners.get('hashchange')();
    // Even returning to gameplay before the IPC finishes cannot revive it.
    location.hash = '#/game';
    release();
    assert.equal((await guard.flush()).status, 'skipped');
    assert.equal(pending, null);
    guard.dispose();
  });
}

test('disposing recovery while reading pending save prevents a native capture', async () => {
  let release;
  let captures = 0;
  const electron = {
    reloadWindow() {},
    getPendingSave: () => new Promise(resolve => { release = resolve; }),
    setPendingSave: async () => { throw new Error('disposed guard staged a save'); },
  };
  const guard = installNativeReloadRecoveryGuard({
    globalObject: {}, electron, location: { hash: '#/game' },
    getCityCode: () => 'NEC_A', captureSnapshot: async () => { captures++; return nativeSave(); },
  });
  const checkpoint = guard.checkpoint();
  guard.dispose();
  release({ success: true, data: null });
  assert.equal((await checkpoint).status, 'skipped');
  assert.equal(captures, 0);
});

test('reload guard replaces a previous hot-reload generation and restores the native method', () => {
  const calls = [];
  const nativeReload = () => calls.push('native');
  const oldWrapper = () => calls.push('old');
  Object.defineProperty(oldWrapper, ORIGINAL_RELOAD_KEY, { value: nativeReload });
  const electron = { reloadWindow: oldWrapper };
  const globalObject = { [RELOAD_GUARD_KEY]: { version: 0 } };

  const guard = installNativeReloadRecoveryGuard({
    globalObject,
    electron,
    location: { hash: '#/' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => nativeSave(),
  });

  assert.equal(guard.version, NATIVE_RELOAD_RECOVERY_VERSION);
  assert.notEqual(electron.reloadWindow, oldWrapper);
  electron.reloadWindow();
  assert.deepEqual(calls, ['native']);
  guard.dispose();
  assert.equal(electron.reloadWindow, nativeReload);
});

test('reload still proceeds when recovery staging fails', async () => {
  const errors = [];
  let reloads = 0;
  const electron = {
    getPendingSave: async () => ({ success: true, data: null }),
    setPendingSave: async () => ({ success: false, error: 'injected staging failure' }),
    reloadWindow: () => { reloads += 1; },
  };
  const guard = installNativeReloadRecoveryGuard({
    globalObject: {},
    electron,
    location: { hash: '#/game?city=NEC_A' },
    getCityCode: () => 'NEC_A',
    captureSnapshot: async () => nativeSave(),
    logger: { error: (...args) => errors.push(args) },
  });

  electron.reloadWindow();
  await guard.flush();

  assert.equal(reloads, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]?.message), /injected staging failure/);
});
