import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installNativeSaveReadBridge } from '../src/host/native-save-read-bridge.js';

function harness(read) {
  const context = vm.createContext({});
  const crossed = [];
  const contextBridge = {
    exposeInMainWorld(key, api) {
      context[key] = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name,
        typeof fn === 'function' ? async (...args) => { const result = await fn(...args); crossed.push({ name, result }); return result; } : fn]));
    },
    executeInMainWorld({ func, args }) {
      context.args = args;
      return vm.runInContext(`(${func.toString()})(...args)`, context);
    },
  };
  const originalExpose = contextBridge.exposeInMainWorld;
  installNativeSaveReadBridge(contextBridge);
  contextBridge.exposeInMainWorld('unrelated', { value: 42 });
  contextBridge.exposeInMainWorld('electron', { getPendingSave: read, untouched: () => 'native' });
  return { api: context.electron, context, crossed, contextBridge, originalExpose };
}

test('large pending save crosses as text and restores every native value', async () => {
  const data = { success: true, data: { name: 'latest', cityCode: 'JP_KANAGAWA_MAINLAND',
    gameSessionId: 'native-session', data: { money: 19174020261240.25, timeConfig: { paused: true, elapsedSeconds: 215890461 },
      compressedDemandData: { c: Array.from({ length: 20000 }, (_, i) => ({ p: `pop-${i}`, s: i, sr: [{ routeId: 'route', stationIds: ['a', 'b'] }] })) } } } };
  const before = structuredClone(data);
  const h = harness(async () => data);
  const actual = await h.api.getPendingSave();
  assert.equal(typeof h.crossed[0].result.text, 'string', 'native bridge must receive one string instead of the nested save graph');
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), before);
  assert.deepEqual(data, before, 'encoding never edits native save authority');
  assert.equal(await h.api.untouched(), 'native');
  assert.equal(h.contextBridge.exposeInMainWorld, h.originalExpose);
  assert.equal(Object.getOwnPropertyDescriptor(h.context, 'electron').writable, false);
  assert.equal(Object.isFrozen(h.api), true);
});

test('identity reads exclude topology, finances and commuter history', async () => {
  const h = harness(async () => ({ success: true, data: { id: 'save.metro', name: 'save',
    gameSessionId: 'session', cityCode: 'JP_A', timestamp: 12,
    metadata: { openWorldNativeRecovery: { schemaVersion: 1, recoveryId: 'r', reason: 'renderer-reload' } },
    data: { routes: [1], money: 50, compressedDemandData: { c: [1] } } } }));
  const result = await h.api.__openWorldGetPendingSaveInfo();
  assert.equal(result.data.id, 'save.metro');
  assert.equal(result.data.gameSessionId, 'session');
  assert.equal(result.data.metadata.openWorldNativeRecovery.recoveryId, 'r');
  assert.equal(Object.hasOwn(result.data, 'data'), false);
});

test('non-JSON values and shared references retain the native transfer semantics', async () => {
  const shared = { station: 'a' };
  const values = [2n, new Date(), new Map([['a', 1]]), { a: shared, b: shared }, new Array(2)];
  const circular = {}; circular.self = circular; values.push(circular);
  for (const data of values) {
    const h = harness(async () => data);
    assert.equal(await h.api.getPendingSave(), data);
    assert.equal(h.crossed[0].result.format, 'native');
  }
});

test('optional native fields and special numbers survive JSON transport exactly', async () => {
  for (const input of [undefined, NaN, Infinity, -Infinity, -0,
    { routeThumbnail: undefined, nested: [undefined, -0, NaN, Infinity, -Infinity] },
    Object.defineProperty({}, '__proto__', { value: undefined, enumerable: true })]) {
    const h = harness(async () => input);
    const actual = await h.api.getPendingSave();
    assert.equal(h.crossed[0].result.format, 'json');
    if (input && typeof input === 'object') {
      assert.deepEqual(structuredClone(actual), structuredClone(input));
    } else assert.ok(Object.is(actual, input));
  }
});

test('errors, empty pending saves and concurrent reads keep their native results', async () => {
  let count = 0;
  const h = harness(async () => {
    if (++count === 1) throw new Error('read failed');
    return { success: true, data: null, count };
  });
  await assert.rejects(h.api.getPendingSave(), /read failed/);
  const results = await Promise.all([h.api.getPendingSave(), h.api.getPendingSave()]);
  assert.deepEqual(results.map(r => r.count), [2, 3]);
  assert.ok(results.every(r => r.data === null));
});

test('unsupported hosts expose their original API', () => {
  let actual;
  const bridge = { exposeInMainWorld: (_key, api) => { actual = api; } };
  const native = { getPendingSave() {} };
  installNativeSaveReadBridge(bridge);
  bridge.exposeInMainWorld('electron', native);
  assert.equal(actual, native);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function localHarness({ write = null, remove = null, messaging = true, delayMessages = false } = {}) {
  const listeners = new Map(), messages = [], crossings = [], calls = [];
  const location = { hash: '#/game?city=JP_A', pathname: '/', search: '' };
  let pending = null;
  const window = {};
  const listen = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  const dispatch = (type, event) => { for (const fn of listeners.get(type) ?? []) fn(event); };
  const ports = [];
  class Port {
    constructor() { this.onmessage = null; this.closed = false; ports.push(this); }
    postMessage(data) { queueMicrotask(() => { if (!this.other.closed) this.other.onmessage?.({ data: structuredClone(data) }); }); }
    start() {}
    close() { this.closed = true; }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.other = this.port2; this.port2.other = this.port1; }
  }
  const timers = new Map();
  const globals = { window, location, URLSearchParams, performance, structuredClone,
    addEventListener: listen, removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); timers.set(timer, fn); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
  };
  if (messaging) {
    globals.MessageChannel = Channel;
    globals.postMessage = (data, _origin, transferred) => {
      // Browser postMessage structured-clones once, preserving graph aliases.
      messages.push({ data: structuredClone(data), ports: transferred });
      if (!delayMessages) queueMicrotask(() => { const next = messages.shift(); if (next) dispatch('message', { ...next, source: window }); });
    };
  }
  const main = vm.createContext({ ...globals }), isolated = vm.createContext({ ...globals });
  const native = {
    async getPendingSave() { calls.push('read'); return { success: true, data: pending }; },
    async setPendingSave(save) {
      calls.push(`set:${save.id}`);
      const result = write ? await write(save) : { success: true };
      if (result?.success !== false) pending = save;
      return result;
    },
    async loadAndSetPendingSave(path) { calls.push(`load:${path}`); pending = { id: path }; return { success: true }; },
    async removePendingSave() {
      calls.push('remove');
      const result = remove ? await remove() : { success: true };
      if (result?.success !== false) pending = null;
      return result;
    },
  };
  const bridge = {
    exposeInMainWorld(key, api) {
      main[key] = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name,
        typeof fn === 'function' ? (...args) => { crossings.push({ name, args }); return fn(...args); } : fn]));
    },
    executeInMainWorld({ func, args }) {
      main.args = args;
      return vm.runInContext(`(${func.toString()})(...args)`, main);
    },
  };
  isolated.bridge = bridge;
  vm.runInContext(`(${installNativeSaveReadBridge.toString()})(bridge)`, isolated);
  bridge.exposeInMainWorld('electron', native);
  return { api: main.electron, calls, crossings, ports, pending: () => pending,
    destination: city => { location.hash = `#/game?city=${city}`; dispatch('hashchange', {}); },
    deliverMessages: () => { for (const message of messages.splice(0)) dispatch('message', { ...message, source: window }); },
    expireTimers: () => { for (const [timer, callback] of [...timers]) { clearTimeout(timer); timers.delete(timer); callback(); } },
    close: () => { for (const timer of timers.keys()) clearTimeout(timer); },
  };
}

function localSave(id = 'recovery-a') {
  const tracks = [{ id: 'track' }];
  return { id, name: id, cityCode: 'JP_B', cityUid: 'JP_B', gameSessionId: 'session',
    data: { routes: [], tracks, trains: [], alias: tracks },
    metadata: { openWorldNativeRecovery: { schemaVersion: 1, reason: 'tile-navigation',
      recoveryId: id, transitionId: `transition-${id}`, sourceCityCode: 'JP_A', destinationCityCode: 'JP_B' } } };
}

test('local handoff backs up once without a graph crossing contextBridge and consumes exact references once', async () => {
  const h = localHarness(), save = localSave();
  try {
    assert.equal(h.api.__openWorldLocalHandoffVersion, 'renderer-local-native-handoff-v1');
    const staged = await h.api.__openWorldStageLocalHandoff(save);
    assert.equal(staged.success, true);
    assert.deepEqual(h.calls, ['set:recovery-a']);
    assert.notEqual(h.pending(), save, 'native recovery backup is a separate structured clone');
    assert.equal(h.pending().data.alias, h.pending().data.tracks, 'postMessage preserves aliases');
    assert.ok(h.crossings.every(call => !call.args.some(arg => arg?.data?.tracks)), 'no save graph enters a contextBridge function');
    const info = await h.api.__openWorldGetPendingSaveInfo();
    assert.equal(info.data.id, save.id);
    assert.equal(info.data.data, undefined);
    h.destination('JP_B');
    assert.equal((await h.api.getPendingSave()).data, save);
    assert.equal((await h.api.getPendingSave()).data, null, 'local native load is one-shot');
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    await h.api.removePendingSave();
    assert.equal(h.pending(), null, 'native loader removes the recovery backup normally');
    assert.deepEqual(h.calls, ['set:recovery-a', 'remove']);
    assert.ok(h.ports.every(port => port.closed));
  } finally { h.close(); }
});

test('stage waits for native backup, and cancellation prevents its late acknowledgement republishing', async () => {
  const gate = deferred(), entered = deferred();
  const h = localHarness({ write: async () => { entered.resolve(); await gate.promise; return { success: true }; } });
  try {
    let done = false;
    const stage = h.api.__openWorldStageLocalHandoff(localSave()).then(value => { done = true; return value; });
    await entered.promise;
    assert.equal(done, false);
    const cancel = h.api.__openWorldCancelLocalHandoff('recovery-a');
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    gate.resolve();
    assert.equal((await stage).success, false);
    assert.equal((await cancel).cancelled, true);
    assert.equal(h.pending(), null);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
  } finally { gate.resolve(); h.close(); }
});

test('explicit native selection supersedes a queued stage and its old cancellation', async () => {
  const gate = deferred(), entered = deferred();
  const h = localHarness({ write: async save => { if (save.id === 'recovery-a') { entered.resolve(); await gate.promise; } return { success: true }; } });
  try {
    const stage = h.api.__openWorldStageLocalHandoff(localSave());
    await entered.promise;
    const selection = h.api.loadAndSetPendingSave('selected.metro');
    const cancel = h.api.__openWorldCancelLocalHandoff('recovery-a');
    gate.resolve();
    assert.equal((await stage).success, false);
    await selection;
    await cancel;
    assert.equal(h.pending().id, 'selected.metro');
    assert.deepEqual(h.calls, ['set:recovery-a', 'load:selected.metro']);
  } finally { gate.resolve(); h.close(); }
});

test('failed native backup is reported and releases local graph instead of silently falling back', async () => {
  const h = localHarness({ write: async () => ({ success: false, error: 'backup failed' }) });
  try {
    const result = await h.api.__openWorldStageLocalHandoff(localSave());
    assert.equal(result.success, false);
    assert.match(result.error, /backup failed/);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    assert.deepEqual(h.calls, ['set:recovery-a']);
    assert.ok(h.ports.every(port => port.closed));
  } finally { h.close(); }
});

test('wrong destination cannot consume local data; departure cancels only the owned backup', async () => {
  const h = localHarness();
  try {
    await h.api.__openWorldStageLocalHandoff(localSave());
    const wrong = await h.api.getPendingSave();
    assert.equal(wrong.success, false);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 1);
    h.destination('JP_C');
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    assert.equal((await h.api.getPendingSave()).data, null);
    assert.equal(h.pending(), null);
  } finally { h.close(); }
});

test('cancellation compares ownership and invalid metadata never writes a native backup', async () => {
  const h = localHarness();
  try {
    const invalid = localSave(); invalid.metadata.openWorldNativeRecovery.reason = 'renderer-reload';
    assert.equal((await h.api.__openWorldStageLocalHandoff(invalid)).success, false);
    assert.deepEqual(h.calls, []);
    await h.api.__openWorldStageLocalHandoff(localSave());
    assert.equal((await h.api.__openWorldCancelLocalHandoff('someone-else')).cancelled, false);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 1);
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).cancelled, true);
    assert.equal(h.pending(), null);
  } finally { h.close(); }
});

test('hosts without window messaging keep the normal native JSON bridge without local capability', async () => {
  const h = localHarness({ messaging: false });
  try {
    assert.equal(h.api.__openWorldLocalHandoffVersion, undefined);
    assert.equal((await h.api.getPendingSave()).data, null);
  } finally { h.close(); }
});

test('late postMessage after a native save selection cannot overwrite that selection', async () => {
  const h = localHarness({ delayMessages: true });
  try {
    const stage = h.api.__openWorldStageLocalHandoff(localSave());
    await new Promise(setImmediate);
    await h.api.setPendingSave({ id: 'manual-save', data: { tracks: [] } });
    h.deliverMessages();
    assert.equal((await stage).success, false);
    assert.equal(h.pending().id, 'manual-save');
    assert.deepEqual(h.calls, ['set:manual-save']);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    await h.api.__openWorldCancelLocalHandoff('recovery-a');
    assert.equal(h.pending().id, 'manual-save');
    assert.ok(h.ports.every(port => port.closed));
  } finally { h.close(); }
});

test('an unfinished native selection blocks local staging instead of queuing another graph', async () => {
  const gate = deferred(), entered = deferred();
  const h = localHarness({ write: async () => { entered.resolve(); await gate.promise; return { success: true }; } });
  try {
    const native = h.api.setPendingSave({ id: 'selected.metro' });
    await entered.promise;
    const stage = await h.api.__openWorldStageLocalHandoff(localSave());
    assert.equal(stage.success, false);
    assert.equal(stage.code, 'handoff-busy');
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    assert.equal(h.ports.length, 0);
    gate.resolve(); await native;
    assert.equal(h.pending().id, 'selected.metro');
  } finally { gate.resolve(); h.close(); }
});

test('a timed-out stage revokes delayed delivery and exact cancellation waits for its cleanup', async () => {
  const h = localHarness({ delayMessages: true });
  try {
    const stage = h.api.__openWorldStageLocalHandoff(localSave());
    await new Promise(setImmediate);
    h.expireTimers();
    assert.equal((await stage).code, 'backup-timeout');
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    await h.api.__openWorldCancelLocalHandoff('recovery-a');
    h.deliverMessages();
    await new Promise(setImmediate);
    assert.deepEqual(h.calls, []);
    assert.ok(h.ports.every(port => port.closed));
    assert.equal((await h.api.getPendingSave()).data, null);
  } finally { h.close(); }
});

test('timeout during backup does not queue further graphs and later removes only its completed write', async () => {
  const gate = deferred(), entered = deferred();
  const h = localHarness({ write: async () => { entered.resolve(); await gate.promise; return { success: true }; } });
  try {
    const stage = h.api.__openWorldStageLocalHandoff(localSave());
    await entered.promise;
    h.expireTimers();
    assert.equal((await stage).success, false);
    assert.equal((await h.api.__openWorldStageLocalHandoff(localSave('another'))).code, 'handoff-busy');
    const cancelled = h.api.__openWorldCancelLocalHandoff('recovery-a');
    gate.resolve();
    await cancelled;
    assert.equal(h.pending(), null);
    assert.deepEqual(h.calls, ['set:recovery-a', 'remove']);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
  } finally { gate.resolve(); h.close(); }
});

test('uncertain backup cleanup blocks native fallback, and an explicit selection restores normal reads', async () => {
  const h = localHarness({ remove: async () => ({ success: false, error: 'remove failed' }) });
  try {
    await h.api.__openWorldStageLocalHandoff(localSave());
    const cancelled = await h.api.__openWorldCancelLocalHandoff('recovery-a');
    assert.equal(cancelled.success, false);
    assert.equal((await h.api.getPendingSave()).success, false);
    assert.ok(!h.calls.includes('read'), 'uncertain native backup must not be silently returned');
    await h.api.loadAndSetPendingSave('manual.metro');
    assert.equal((await h.api.getPendingSave()).data.id, 'manual.metro');
  } finally { h.close(); }
});

test('new-game native clear removes both an unread local handoff and its native backup', async () => {
  const h = localHarness();
  try {
    await h.api.__openWorldStageLocalHandoff(localSave());
    await h.api.removePendingSave();
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    assert.equal((await h.api.getPendingSave()).data, null);
    assert.deepEqual(h.calls, ['set:recovery-a', 'remove', 'read']);
  } finally { h.close(); }
});

test('failed backup removal remains owned and can be retried without retaining the local graph', async () => {
  let attempts = 0;
  const h = localHarness({ remove: async () => ++attempts === 1
    ? { success: false, error: 'temporarily locked' } : { success: true } });
  try {
    await h.api.__openWorldStageLocalHandoff(localSave());
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).success, false);
    assert.equal(h.api.__openWorldLocalHandoffStats().retainedPayloads, 0);
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).success, true);
    assert.equal(h.pending(), null);
    assert.equal((await h.api.getPendingSave()).data, null);
    assert.deepEqual(h.calls, ['set:recovery-a', 'remove', 'remove', 'read']);
  } finally { h.close(); }
});

test('a newer handoff cannot shadow a failed cleanup and proceeds after exact retry succeeds', async () => {
  let attempts = 0;
  const h = localHarness({ remove: async () => ++attempts === 1
    ? { success: false, error: 'temporarily locked' } : { success: true } });
  try {
    await h.api.__openWorldStageLocalHandoff(localSave());
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).success, false);
    const next = localSave('recovery-b');
    assert.equal((await h.api.__openWorldStageLocalHandoff(next)).code, 'backup-cancel-failed');
    assert.equal(h.pending().id, 'recovery-a');
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).success, true);
    assert.equal((await h.api.__openWorldStageLocalHandoff(next)).success, true);
    h.destination('JP_B');
    assert.equal((await h.api.getPendingSave()).data, next);
    assert.equal((await h.api.__openWorldCancelLocalHandoff('recovery-a')).cancelled, false);
    assert.equal(h.pending().id, 'recovery-b');
  } finally { h.close(); }
});
