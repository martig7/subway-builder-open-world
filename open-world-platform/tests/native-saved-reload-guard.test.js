import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeSavedReloadGuard, NATIVE_SAVED_RELOAD_VERSION } from '../src/runtime/native-saved-reload-guard.js';

function fixture({ frozen = true, pending = null } = {}) {
  const listeners = new Map(), calls = { reads: 0, loads: [], reloads: 0, clears: 0 };
  const location = { hash: '#/game' };
  let session = 'session', timer;
  const files = [{ name: 'saved', path: 'saved.metro', timestamp: 10, gameSessionId: session, cityCode: 'JP_A' }];
  const globalObject = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  };
  const electron = {
    reloadWindow() { calls.reloads++; },
    async getPendingSave() { calls.reads++; return { success: true, data: pending }; },
    async getMostRecentSaves() { return { success: true, saves: files }; },
    async loadAndSetPendingSave(path) {
      calls.loads.push(path);
      pending = { ...files.find(f => f.path === path), data: { routes: [], tracks: [], trains: [] } };
      return { success: true };
    },
    async removePendingSave() { calls.clears++; pending = null; },
  };
  if (frozen) Object.defineProperty(electron, 'reloadWindow', { writable: false });
  const options = { globalObject, electron, location, getSessionId: () => session, getCityCode: () => 'JP_A',
    logger: { error() {} }, setIntervalFn: fn => { timer = fn; return 1; }, clearIntervalFn() { timer = null; } };
  return { options, electron, calls, files, location, globalObject, listeners,
    tick: async guard => { timer(); await guard.flush(); },
    setPending: value => { pending = value; }, getPending: () => pending,
    setSession: value => { session = value; } };
}

test('tile transition UUIDs wait for a completed native file instead of being decoded as paths', async () => {
  const f = fixture();
  f.files.length = 0;
  f.options.getLoadedSave = () => ({ path: '926b7cad-2a4d-4d2f-b5ff-b9a0bb6058c9',
    name: 'open-world-runtime', gameSessionId: 'session', cityCode: 'JP_A' });
  f.options.now = () => 20;
  const guard = installNativeSavedReloadGuard(f.options);
  await guard.flush();
  assert.deepEqual(f.calls.loads, []);
  assert.equal((await guard.checkpoint()).status, 'waiting-for-native-save');
  f.files.push({ path: 'after-switch.metro', timestamp: 21, gameSessionId: 'session', cityCode: 'JP_A' });
  await guard.checkpoint();
  assert.deepEqual(f.calls.loads, ['after-switch.metro']);
  guard.dispose();
});

test('frozen bridge stages completed files without repeatedly copying pending or live saves', async () => {
  const f = fixture(), guard = installNativeSavedReloadGuard(f.options);
  await guard.flush();
  assert.equal(guard.mode, 'saved-file-checkpoint');
  assert.deepEqual(f.calls.loads, ['saved.metro']);
  for (let i = 0; i < 5; i++) await f.tick(guard);
  assert.equal(f.calls.reads, 1, 'large pending payload is inspected only at attachment');
  assert.equal(f.calls.loads.length, 1, 'unchanged files are not decoded again');
  f.files.push({ ...f.files[0], path: 'new.metro', timestamp: 11 });
  await f.tick(guard);
  assert.deepEqual(f.calls.loads, ['saved.metro', 'new.metro']);
  assert.equal(f.calls.reads, 1);
  assert.equal(guard.snapshot().lastSave.path, 'new.metro');
  guard.dispose();
});

test('tile handoff suspension prevents a timer from replacing its pending native save', async () => {
  const f = fixture(), guard = installNativeSavedReloadGuard(f.options);
  await guard.flush();
  const resume = await guard.suspendForTileNavigation();
  const handoff = { metadata: { openWorldNativeRecovery: { reason: 'tile-navigation' } } };
  f.setPending(handoff);
  f.files.push({ ...f.files[0], path: 'newer.metro', timestamp: 12 });
  await f.tick(guard);
  assert.equal(f.getPending(), handoff);
  assert.equal((await guard.checkpoint()).status, 'tile-navigation');
  resume(); resume();
  await guard.checkpoint();
  assert.equal(f.calls.loads.at(-1), 'newer.metro');
  guard.dispose();
});

test('tile handoff suspension drains a pending native file decode before returning', async () => {
  const f = fixture();
  let finish;
  const load = f.electron.loadAndSetPendingSave;
  f.electron.loadAndSetPendingSave = path => new Promise(resolve => {
    finish = async () => resolve(await load(path));
  });
  const guard = installNativeSavedReloadGuard(f.options);
  await new Promise(resolve => setImmediate(resolve));
  let suspended = false;
  const suspension = guard.suspendForTileNavigation().then(resume => {
    suspended = true;
    return resume;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(suspended, false);
  await finish();
  const resume = await suspension;
  const handoff = { name: 'live handoff' };
  f.setPending(handoff);
  await f.tick(guard);
  assert.equal(f.getPending(), handoff);
  resume(); guard.dispose();
});

test('explicit pending saves and uncertain ownership are preserved', async () => {
  const explicit = { gameSessionId: 'chosen', name: 'chosen', timestamp: 1 };
  const f = fixture({ pending: explicit });
  let guard = installNativeSavedReloadGuard(f.options);
  await guard.flush(); await f.tick(guard);
  assert.equal(f.getPending(), explicit); assert.equal(f.calls.loads.length, 0);
  guard.dispose();
  f.electron.getPendingSave = async () => ({ success: false, error: 'unavailable' });
  guard = installNativeSavedReloadGuard(f.options);
  await guard.flush();
  assert.equal(f.calls.loads.length, 0); assert.match(guard.snapshot().error, /unavailable/);
  guard.dispose();
});

test('only matching session and city files qualify, and a failed load can be retried', async () => {
  const f = fixture();
  f.files.push({ ...f.files[0], path: 'foreign.metro', timestamp: 100, gameSessionId: 'other' },
    { ...f.files[0], path: 'tile.metro', timestamp: 101, cityCode: 'JP_B' });
  const load = f.electron.loadAndSetPendingSave;
  f.electron.loadAndSetPendingSave = async () => ({ success: false, error: 'busy' });
  const guard = installNativeSavedReloadGuard(f.options);
  await guard.flush(); assert.equal(guard.savedFile, null);
  f.electron.loadAndSetPendingSave = load;
  await f.tick(guard); assert.deepEqual(f.calls.loads, ['saved.metro']);
  guard.dispose();
});

test('hot reload replaces the preceding guard and wrapper, preserving its saved-file ownership', async () => {
  const f = fixture({ frozen: false }), original = f.electron.reloadWindow;
  const old = installNativeSavedReloadGuard(f.options); await old.flush();
  const oldWrapper = f.electron.reloadWindow;
  old.version = 'previous-generation';
  const guard = installNativeSavedReloadGuard(f.options); await guard.flush();
  assert.notEqual(guard, old); assert.notEqual(f.electron.reloadWindow, oldWrapper);
  assert.equal(f.electron.reloadWindow.__openWorldNativeReloadRecoveryVersion__, NATIVE_SAVED_RELOAD_VERSION);
  assert.equal(f.electron.reloadWindow.__openWorldNativeReloadRecoveryOriginal__, original);
  await f.electron.reloadWindow();
  assert.equal(f.calls.reloads, 1); assert.equal(f.calls.loads.length, 1, 'retained pending save is not decoded again');
  guard.dispose(); assert.equal(f.electron.reloadWindow, original);
});

test('leaving the game clears only the file this guard staged', async () => {
  for (const replace of [false, true]) {
    const f = fixture(), guard = installNativeSavedReloadGuard(f.options); await guard.flush();
    if (replace) f.setPending({ name: 'selected', timestamp: 900, gameSessionId: 'different' });
    f.location.hash = '#/'; f.listeners.get('hashchange')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.clears, replace ? 0 : 1);
    guard.dispose();
  }
});

test('explicit module disposal retains only file identity for the next attachment', async () => {
  const f = fixture(), old = installNativeSavedReloadGuard(f.options);
  await old.flush(); old.dispose();
  const guard = installNativeSavedReloadGuard(f.options); await guard.flush();
  f.files.push({ ...f.files[0], path: 'after-reload.metro', timestamp: 30 });
  await f.tick(guard);
  assert.equal(guard.savedFile.path, 'after-reload.metro');
  assert.equal(f.globalObject.__openWorldSavedReloadFile__.data, undefined);
  guard.dispose();
});

test('file identity survives the native loader substituting mtime for the header timestamp', async () => {
  const f = fixture(), old = installNativeSavedReloadGuard(f.options); await old.flush();
  f.setPending({ ...f.files[0], path: undefined, id: f.files[0].path, timestamp: 1234.567 });
  old.dispose();
  const guard = installNativeSavedReloadGuard(f.options); await guard.flush();
  assert.equal(guard.savedFile.path, f.files[0].path);
  f.setPending({ ...f.files[0], path: undefined, id: f.files[0].path, timestamp: 1234.567 });
  f.location.hash = '#/'; f.listeners.get('hashchange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.clears, 1); guard.dispose();
});

test('loading an older save cannot recover a newer historical branch of the same session', async () => {
  const f = fixture();
  f.files.push({ ...f.files[0], path: 'historical-future.metro', timestamp: 50 });
  const guard = installNativeSavedReloadGuard({ ...f.options, now: () => 100, getLoadedSave: () => f.files[0] });
  await guard.flush(); assert.equal(guard.savedFile.path, 'saved.metro');
  f.files.push({ ...f.files[0], path: 'new-progress.metro', timestamp: 101 });
  await f.tick(guard); assert.equal(guard.savedFile.path, 'new-progress.metro');
  guard.resetForLoad({ bootstrap: true });
  guard.resetForLoad({ bootstrap: true });
  assert.equal(guard.savedFile.path, 'new-progress.metro', 'bootstrap replay retains the current checkpoint');
  guard.resetForLoad(); f.setPending(null);
  f.files.pop();
  await f.tick(guard); assert.equal(guard.savedFile.path, 'saved.metro');
  guard.dispose();
});

test('a retained pending payload survives pruning of its autosave file and bootstrap replay', async () => {
  const f = fixture(), old = installNativeSavedReloadGuard(f.options); await old.flush(); old.dispose();
  f.files.length = 0;
  f.electron.loadAndSetPendingSave = async () => { throw new Error('file pruned'); };
  const guard = installNativeSavedReloadGuard(f.options); await guard.flush();
  guard.resetForLoad({ bootstrap: true }); await f.tick(guard);
  assert.equal(guard.savedFile.path, 'saved.metro'); assert.equal(guard.snapshot().error, null);
  guard.dispose();
});

test('a file loaded after route cancellation cannot remain as a stale handoff', async () => {
  const f = fixture(); let finish;
  const load = f.electron.loadAndSetPendingSave;
  f.electron.loadAndSetPendingSave = path => new Promise(resolve => { finish = async () => resolve(await load(path)); });
  const guard = installNativeSavedReloadGuard(f.options);
  await new Promise(resolve => setImmediate(resolve));
  f.location.hash = '#/'; f.listeners.get('hashchange')();
  await finish(); await guard.flush();
  assert.equal(f.getPending(), null); assert.equal(guard.snapshot().staged, 0);
  guard.dispose();
});

test('legacy renderer checkpoints are replaced but navigation handoffs are preserved', async () => {
  for (const reason of ['renderer-reload', 'tile-navigation']) {
    const f = fixture({ pending: { metadata: { openWorldNativeRecovery: { schemaVersion: 1, reason } } } });
    const guard = installNativeSavedReloadGuard(f.options); await guard.flush();
    assert.equal(f.calls.loads.length, reason === 'renderer-reload' ? 1 : 0);
    guard.dispose();
  }
});
