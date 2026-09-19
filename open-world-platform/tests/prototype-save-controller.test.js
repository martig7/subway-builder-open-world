import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototypeSaveController, blockSaveEdits } from '../src/runtime/prototype-save-controller.js';

function fixture({ writeSave, busy = false } = {}, controllerOptions = {}) {
  const state = { cityCode: 'CITY', gameSessionId: 'session', timeConfig: { paused: false, elapsedSeconds: 100 }, money: 500,
    setTimeConfig(value) { state.timeConfig = { ...state.timeConfig, ...value }; },
    generateSave(options) {
      assert.equal(options[Symbol.for('open-world.stream-native-save')], true);
      return { version: 4, name: options.name,
        data: { timeConfig: state.timeConfig, money: state.money,
          compressedDemandData: { v: 2, p: [['pop', 1]], d: [], c: [{ p: 'pop', s: 1 }, { p: 'pop', s: 2 }] } } };
    } };
  let closed = 0, nativeCalls = 0, uploads = 0;
  const controller = createPrototypeSaveController({ getState: () => state, isBusy: () => busy, yieldTask: async () => {},
    settleMs: 0, ...controllerOptions,
    freezeUi: cancel => { const ui = controllerOptions.freezeUi?.(cancel); return { progress: value => ui?.progress?.(value), dispose() { closed++; ui?.dispose?.(); } }; },
    fetchFn: controllerOptions.fetchFn ?? (async () => Response.json({ version: 'tile-save-prototype-v1' })),
    writeSave: async (save, options) => {
      uploads++; assert.equal(state.timeConfig.paused, true); assert.equal(save.data.timeConfig.paused, false);
      if (writeSave) return writeSave(save, options, state);
      options.beforeCommit(); return { bytes: 123, durationMs: 50, path: 'fixture.metro' };
    },
  });
  const configure = async () => { await controller.configure({ origin: 'http://127.0.0.1:8800', token: 'fixture-control-token' }); controller.setEnabled(true); };
  return { state, controller, configure, native: () => { nativeCalls++; return 'native'; }, counts: () => ({ closed, nativeCalls, uploads }) };
}

test('prototype is opt-in, saves with a stable pause, and restores playback without retaining the snapshot', async () => {
  const f = fixture();
  assert.equal(f.controller.invoke(f.native), 'native');
  await f.configure();
  assert.equal(f.controller.snapshot().transport, null, 'enabling must clear the previous native selection');
  const result = await f.controller.invoke(f.native);
  assert.equal(result.path, 'fixture.metro'); assert.equal(f.state.timeConfig.paused, false);
  assert.deepEqual(f.counts(), { closed: 1, nativeCalls: 1, uploads: 1 });
  assert.equal(f.controller.snapshot().last.data, undefined);
});

test('an enabled writer never invokes native saving after a gate rejection or transfer failure', async () => {
  for (const options of [{ busy: true }, { writeSave: async () => { throw new Error('Writer unavailable'); } }]) {
    const f = fixture(options);
    await f.configure();
    await f.controller.invoke(f.native);
    assert.equal(f.counts().nativeCalls, 0, 'experimental failures must not start a long native save');
    assert.equal(f.controller.snapshot().enabled, true, 'future autosaves must not silently become native');
    assert.equal(f.state.timeConfig.paused, false);
    assert.equal(f.controller.snapshot().status, 'failed');
  }
});

test('pre-upload progress identifies settling and snapshot generation before work begins', async () => {
  const phases = [];
  const f = fixture();
  await f.configure();
  f.controller.subscribe(value => { if (value.phase) phases.push(value.phase); });
  const generate = f.state.generateSave;
  f.state.generateSave = options => {
    assert.equal(f.controller.snapshot().phase, 'generating');
    return generate(options);
  };
  await f.controller.invoke(f.native);
  assert.ok(phases.includes('settling'));
  assert.ok(phases.includes('generating'));
});

test('a failed transfer releases the pause, reports no save, and stays armed', async () => {
  let fail;
  const failure = new Promise((_, reject) => { fail = reject; });
  const f = fixture({ writeSave: () => failure }); await f.configure();
  const first = f.controller.invoke(f.native), second = f.controller.invoke(f.native);
  assert.equal(first, second);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  fail(new Error('Disk full'));
  assert.equal((await first).saved, false);
  assert.equal(f.controller.snapshot().enabled, true); assert.equal(f.state.timeConfig.paused, false);
  assert.deepEqual(f.counts(), { closed: 1, nativeCalls: 0, uploads: 1 });
});

test('concurrent routing prevents an unstable upload without starting a native save', async () => {
  const f = fixture({ busy: true }); await f.configure();
  assert.equal((await f.controller.invoke(f.native)).saved, false);
  assert.equal(f.counts().uploads, 0); assert.equal(f.state.timeConfig.paused, false);
});

test('an uncertain commit remains explicit and never triggers a second native save', async () => {
  const f = fixture({ writeSave: async () => { throw Object.assign(new Error('Lost commit receipt'), { saveOutcome: 'unknown' }); } });
  await f.configure();
  const result = await f.controller.invoke(f.native);
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.error, /Check the save list before retrying/);
  assert.doesNotMatch(result.error, /No new save was written|Autosave was not saved/);
  assert.equal(f.counts().nativeCalls, 0);
  assert.equal(f.state.timeConfig.paused, false);
  assert.equal(f.controller.snapshot().enabled, true);
});

test('a busy session reports that no save was written and keeps the prototype armed', async () => {
  const f = fixture({ busy: true }); await f.configure();
  assert.equal((await f.controller.invoke(f.native)).saved, false);
  assert.equal(f.controller.snapshot().enabled, true, 'gate rejections must not uncheck the session toggle');
  assert.match(f.controller.snapshot().error, /still changing/);
  assert.equal(f.state.timeConfig.paused, false);
  assert.deepEqual(f.counts(), { closed: 1, nativeCalls: 0, uploads: 0 });
});

test('a settling session waits briefly, then uploads once routing drains', async () => {
  let busy = true, yields = 0;
  const f = fixture({}, { settleMs: 1000, isBusy: () => busy,
    yieldTask: async () => { yields++; if (yields >= 4) busy = false; } });
  await f.configure();
  const result = await f.controller.invoke(f.native);
  assert.equal(result.path, 'fixture.metro');
  assert.ok(yields >= 4, 'capture must wait for the quiet moment instead of failing on the first busy sample');
  assert.equal(f.controller.snapshot().enabled, true);
  assert.deepEqual(f.counts(), { closed: 1, nativeCalls: 0, uploads: 1 });
});

test('a changing ledger rejects commit and a new session cannot receive the old fallback or playback state', async () => {
  for (const changeSession of [false, true]) {
    const f = fixture({ writeSave: async (save, options, state) => {
      if (changeSession) state.gameSessionId = 'another-save'; else state.money++;
      options.beforeCommit(); throw new Error('Unexpected accepted mutation');
    } }); await f.configure();
    await f.controller.invoke(f.native);
    assert.equal(f.counts().nativeCalls, 0);
    assert.equal(f.controller.snapshot().transport, 'prototype');
    assert.equal(f.state.timeConfig.paused, changeSession);
    assert.match(f.controller.snapshot().error, /Game state changed/);
  }
});

test('each new attempt resets uploaded bytes and the previous failure', async () => {
  let busy = false;
  const f = fixture({}, { isBusy: () => busy });
  await f.configure();
  await f.controller.invoke(f.native);
  assert.equal(f.controller.snapshot().progress, 123);
  busy = true;
  await f.controller.invoke(f.native);
  assert.equal(f.controller.snapshot().status, 'failed');
  busy = false;
  const starts = [];
  f.controller.subscribe(value => { if (value.status === 'saving') starts.push(value); });
  await f.controller.invoke(f.native);
  assert.ok(starts.length >= 1);
  assert.equal(starts[0].progress, 0, 'settling/generating must not show bytes from the previous upload');
  assert.equal(starts[0].transport, 'prototype', 'the new attempt has not used native fallback');
  assert.equal(starts[0].error, null);
});

test('disposal aborts its upload without invoking a retired native callback', async () => {
  const f = fixture({ writeSave: async (save, options) => {
    f.controller.dispose(); options.signal.throwIfAborted();
  } }); await f.configure(); await f.controller.invoke(f.native);
  assert.equal(f.counts().nativeCalls, 0); assert.equal(f.counts().closed, 1); assert.equal(f.state.timeConfig.paused, false);
});

test('automatic configuration connects without a token and survives the manual pairing step', async () => {
  const seen = [];
  const f = fixture();
  const fetchFn = async (url, options) => {
    seen.push({ url: String(url), token: options?.headers?.['X-PMTiles-Control-Token'] });
    if (String(url).includes('8800')) throw new Error('prototype host down');
    return Response.json({ version: 'tile-save-prototype-v1' });
  };
  const before = await f.controller.configureAutomatic({ origins: ['https://example.com/', 'http://127.0.0.1:8800', 'http://127.0.0.1:8799'], fetchFn });
  assert.equal(before.configured, true);
  assert.equal(seen.length, 2, 'remote origins are skipped and the first live writer wins');
  assert.equal(seen[0].token, undefined, 'game-origin discovery carries no per-boot token');
  assert.equal(f.controller.snapshot().status, 'ready');
  // A later retry is a no-op once configured.
  await f.controller.configureAutomatic({ origins: ['http://127.0.0.1:9999'], fetchFn });
  assert.equal(seen.length, 2);
});

test('automatic configuration stays quiet when no writer answers', async () => {
  const f = fixture();
  const fetchFn = async () => { throw new Error('no server'); };
  const snapshot = await f.controller.configureAutomatic({ origins: ['http://127.0.0.1:8800'], fetchFn });
  assert.equal(snapshot.configured, false);
  assert.equal(f.controller.invoke(f.native), 'native');
});

test('automatic configuration ignores version mismatches', async () => {
  const f = fixture();
  const fetchFn = async () => Response.json({ version: 'tile-save-prototype-v0' });
  assert.equal((await f.controller.configureAutomatic({ origins: ['http://127.0.0.1:8800'], fetchFn })).configured, false);
});

test('reconnect reuses remembered origins and throttles failed probes', async () => {
  const f = fixture();
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('no server'); };
  await f.controller.configureAutomatic({ origins: ['http://127.0.0.1:8800', 'http://127.0.0.1:8799'], fetchFn });
  assert.equal(calls, 2);
  await f.controller.reconnect({ fetchFn });
  assert.equal(calls, 4, 'a later panel open re-probes the remembered origins');
  await f.controller.reconnect({ fetchFn });
  assert.equal(calls, 4, 'immediate repeats stay quiet');
});

test('a completed save records settle timing and the prototype transport', async () => {
  let busy = true, yields = 0;
  const f = fixture({}, { settleMs: 60000, isBusy: () => busy,
    yieldTask: async () => { yields++; if (yields >= 2) busy = false; } });
  await f.configure();
  await f.controller.invoke(f.native);
  const last = f.controller.snapshot().last;
  assert.ok(typeof last.settleMs === 'number' && last.settleMs >= 0, 'settle wait must be timed');
  assert.equal(f.controller.snapshot().transport, 'prototype');
});

test('a prototype upload streams the save without journey-history rows', async () => {
  let uploaded = null;
  const f = fixture({ writeSave: async (save, options) => {
    uploaded = save; options.beforeCommit(); return { bytes: 456, durationMs: 60, path: 'slim.metro' };
  } });
  await f.configure();
  const result = await f.controller.invoke(f.native);
  assert.equal(result.path, 'slim.metro');
  assert.deepEqual(uploaded.data.compressedDemandData.c, []);
  assert.deepEqual(uploaded.data.compressedDemandData.p, [['pop', 1]], 'the demand model must stream untouched');
  assert.equal(f.state.money, 500, 'slimming must not touch the live game');
  assert.equal(f.controller.snapshot().last.omittedJourneyRows, 2);
});

test('a gate rejection reports its failed phase while staying armed', async () => {
  const f = fixture({ busy: true }); await f.configure();
  assert.equal((await f.controller.invoke(f.native)).saved, false);
  assert.equal(f.controller.snapshot().transport, 'prototype');
  assert.equal(f.controller.snapshot().failedPhase, 'settling');
  assert.equal(f.controller.snapshot().enabled, true);
});

test('an unavailable writer fails before freezing, generating, or starting native saving', async () => {
  let available = true;
  const events = [];
  const f = fixture({}, { fetchFn: async () => {
    if (!available) throw new Error('Writer stopped');
    return Response.json({ version: 'tile-save-prototype-v1' });
  }, onActivity: (stage, details) => events.push({ stage, details }) });
  await f.configure(); available = false;
  f.state.generateSave = () => { throw new Error('Must not generate'); };
  const result = await f.controller.invoke(f.native);
  assert.equal(result.saved, false);
  assert.equal(f.controller.snapshot().failedPhase, 'checking');
  assert.equal(f.controller.snapshot().enabled, true);
  assert.equal(f.state.timeConfig.paused, false);
  assert.deepEqual(f.counts(), { closed: 0, nativeCalls: 0, uploads: 0 });
  assert.match(events.find(e => e.stage === 'tile-save.error').details.error, /Writer stopped/);
});

test('cancel during settling is immediate, leaves the writer enabled, and never generates', async () => {
  let cancel, yields = 0;
  const f = fixture({ busy: true }, { settleMs: 30000,
    freezeUi: value => { cancel = value; },
    yieldTask: async () => { if (++yields === 3) cancel(); },
  });
  await f.configure();
  f.state.generateSave = () => { throw new Error('Must not generate'); };
  const result = await f.controller.invoke(f.native);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.saved, false);
  assert.equal(f.controller.snapshot().enabled, true);
  assert.equal(f.state.timeConfig.paused, false);
  assert.deepEqual(f.counts(), { closed: 1, nativeCalls: 0, uploads: 0 });
});

test('reconnect is a no-op once configured', async () => {
  const f = fixture();
  let calls = 0;
  const fetchFn = async () => { calls++; return Response.json({ version: 'tile-save-prototype-v1' }); };
  await f.controller.configureAutomatic({ origins: ['http://127.0.0.1:8800'], fetchFn });
  await f.controller.reconnect({ fetchFn });
  assert.equal(calls, 1);
});

test('the save overlay captures game shortcuts even when its cancel button has focus', () => {
  const handlers = new Map(); let focused, cancels = 0;
  const window = { addEventListener(name, handler, options) { assert.equal(options.capture, true); handlers.set(name, handler); },
    removeEventListener(name) { handlers.delete(name); } };
  const document = { body: { append() {} }, createElement: () => ({ style: {}, setAttribute() {}, append() {}, remove() {}, focus() { focused = this; } }) };
  const ui = blockSaveEdits(() => { cancels++; }, { document, window });
  let blocked = 0;
  handlers.get('keydown')({ type: 'keydown', key: 'p', target: focused, preventDefault() { blocked++; }, stopImmediatePropagation() { blocked++; } });
  assert.equal(blocked, 2); assert.equal(cancels, 0);
  handlers.get('click')({ type: 'click', target: focused, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(cancels, 1); ui.dispose(); assert.equal(handlers.size, 0);
});
