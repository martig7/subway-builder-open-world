import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererDebugRecorder, recorderPayload, RENDERER_DEBUG_RECORDER_VERSION as version } from '../src/runtime/renderer-debug-recorder.js';

function fixture(fetchImpl, snapshot) {
  const calls = [], cursors = [], root = {};
  const recorder = installRendererDebugRecorder({ root, baseUrl: 'http://127.0.0.1:8799', autoStart: false,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); },
    setTimeoutFn: () => 1, clearTimeoutFn() {},
    getSnapshot: cursor => { cursors.push(cursor); return snapshot?.() ?? { captureId: 'capture', latest: { id: 3, usedBytes: 123 }, activities: [{ id: 2, activity: 'save' }] }; },
  });
  return { recorder, root, calls, cursors };
}
const response = enabled => ({ ok: true, json: async () => ({ version, enabled }) });

test('manager switch starts recording and stops sample generation without retaining history', async () => {
  let enabled = false;
  const f = fixture(() => response(enabled));
  await f.recorder.tick();
  assert.equal(f.cursors.length, 0);
  enabled = true;
  await f.recorder.tick();
  await f.recorder.tick();
  assert.equal(f.calls.at(-1)[1].method, 'POST');
  const sample = JSON.parse(f.calls.at(-1)[1].body);
  assert.equal(sample.latest.usedBytes, 123);
  await f.recorder.tick();
  assert.equal(f.cursors.at(-1).afterSampleId, 3);
  enabled = false;
  await f.recorder.tick();
  const count = f.cursors.length;
  await f.recorder.tick();
  assert.equal(f.cursors.length, count);
  f.recorder.dispose();
});

test('a stalled server has one pending request and disposal aborts it', async () => {
  let finish, signal;
  const f = fixture((url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.recorder.tick();
  await f.recorder.tick();
  assert.equal(f.calls.length, 1);
  f.recorder.dispose();
  assert.equal(signal.aborted, true);
  finish(response(true)); await pending;
  assert.equal(f.root.__openWorldRendererDebugRecorder__, undefined);
  await f.recorder.tick();
  assert.equal(f.calls.length, 1);
});

test('hot replacement disposes the previous generation and its request', async () => {
  const f = fixture(() => response(true));
  const previous = f.recorder;
  previous.version = 'renderer-debug-recorder-v0';
  const next = installRendererDebugRecorder({ root: f.root, baseUrl: 'http://127.0.0.1:8799', autoStart: false });
  assert.notEqual(next, previous);
  await previous.tick();
  assert.equal(f.calls.length, 0);
  previous.dispose();
  assert.equal(f.root.__openWorldRendererDebugRecorder__, next);
  next.dispose();
});

test('payloads contain only bounded scalars and short activity tails', () => {
  const sample = recorderPayload({ captureId: 'capture', latest: { id: 3, game: { huge: true }, usedBytes: 1, activity: 'a'.repeat(1000) },
    events: Array.from({ length: 100 }, (_, id) => ({ id, kind: 'growth' })), activities: [] }, { cityCode: 'JP_PREF_11', network: [] }, 'client');
  assert.equal(sample.latest.game, undefined);
  assert.equal(sample.context.network, undefined);
  assert.equal(sample.latest.activity.length, 128);
  assert.equal(sample.events.length, 16);
  assert.equal(sample.events[0].id, 84);
  assert.throws(() => installRendererDebugRecorder({ baseUrl: 'https://external.example', root: {}, autoStart: false }), /local tile server/);
});

test('a failed upload retries discovery and never advances its capture cursor', async () => {
  let fail = false;
  const f = fixture(() => { if (fail) throw Error('offline'); return response(true); });
  await f.recorder.tick(); fail = true; await f.recorder.tick();
  assert.equal(f.recorder.snapshot().failures, 1);
  fail = false; await f.recorder.tick(); await f.recorder.tick();
  assert.equal(f.cursors.at(-1).afterSampleId, undefined);
  f.recorder.dispose();
});

test('a fresh diagnostic capture resets an old activity cursor even when its activity list is empty', async () => {
  let sample = { captureId: 'old', latest: { id: 100 }, activities: [{ id: 99 }] };
  const f = fixture(() => response(true), () => sample);
  await f.recorder.tick(); await f.recorder.tick();
  sample = { captureId: 'new', latest: { id: 1 }, activities: [] };
  await f.recorder.tick(); await f.recorder.tick();
  assert.equal(f.cursors.at(-1).captureId, 'new');
  assert.equal(f.cursors.at(-1).afterActivityId, 0);
  f.recorder.dispose();
});
