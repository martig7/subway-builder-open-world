import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findNativeAutosaveRef, installNativeAutosaveIdleGuard } from '../src/runtime/native-autosave-idle-guard.js';

function fixture() {
  let time = 0, moving = true, timer, identity = 'session';
  const calls = [], ref = { current: async () => { calls.push('old'); return 42; } };
  const guard = installNativeAutosaveIdleGuard({ ref, isMoving: () => moving, getIdentity: () => identity,
    now: () => time, quietMs: 200, maxDelayMs: 1000,
    setTimeoutFn: fn => { timer = fn; return 1; }, clearTimeoutFn: () => { timer = null; } });
  return { guard, ref, calls, setMoving: v => { moving = v; }, setIdentity: v => { identity = v; },
    async tick(ms) { time += ms; const fn = timer; timer = null; fn?.(); await Promise.resolve(); } };
}

test('native autosave waits for idle, coalesces ticks and uses the latest React callback', async () => {
  const f = fixture();
  const first = f.ref.current(), second = f.ref.current();
  assert.equal(first, second); assert.deepEqual(f.calls, []);
  await f.tick(100);
  f.ref.current = async () => { f.calls.push('new'); return 99; };
  f.setMoving(false); await f.tick(250);
  assert.equal(await first, 99); assert.deepEqual(f.calls, ['new']);
  f.guard.dispose();
  assert.equal(await f.ref.current(), 99);
});

test('continuous interaction cannot defer a due save indefinitely', async () => {
  const f = fixture(), result = f.ref.current();
  await f.tick(999); assert.equal(f.calls.length, 0);
  await f.tick(1); assert.equal(await result, 42); assert.equal(f.calls.length, 1);
  assert.equal(f.guard.snapshot().deadlineSaves, 1); f.guard.dispose();
});

test('short gaps between pans do not start a synchronous save', async () => {
  const f = fixture(); f.guard.noteMovement(); f.setMoving(false);
  const result = f.ref.current();
  await f.tick(100); assert.equal(f.calls.length, 0);
  await f.tick(100); assert.equal(await result, 42);
  f.guard.dispose();
});

test('native discovery targets the autosave callback and leaves unknown game builds alone', () => {
  function AutosaveManager() {}
  const ref = { current: function performAutosave() {
    // [Autosave] performAutosaveCallback called
    // validateSaveData, markAutosaveStart
  } };
  const root = { '__reactContainer$test': { stateNode: { current: {
    child: { type: AutosaveManager, memoizedState: { memoizedState: ref } },
  } } } };
  assert.equal(findNativeAutosaveRef({ getElementById: () => root }), ref);
  ref.current = () => 'changed native implementation';
  assert.equal(findNativeAutosaveRef({ getElementById: () => root }), null);
});

test('a pending save cannot cross into another native session', async () => {
  const f = fixture(), result = f.ref.current();
  f.setIdentity('different'); await f.tick(1000);
  await result; assert.equal(f.calls.length, 0); f.guard.dispose();
});

test('hot attachment replaces the old property wrapper and disposal cancels only deferred work', async () => {
  const f = fixture(), oldGetter = Object.getOwnPropertyDescriptor(f.ref, 'current').get;
  f.guard.version = 'native-autosave-idle-v3';
  const result = f.ref.current();
  const next = installNativeAutosaveIdleGuard({ ref: f.ref, isMoving: () => false });
  await result; assert.equal(f.calls.length, 0);
  assert.notEqual(Object.getOwnPropertyDescriptor(f.ref, 'current').get, oldGetter);
  assert.notEqual(next, f.guard);
  assert.equal(next.version, 'native-autosave-idle-v4');
  assert.equal(await f.ref.current(), 42);
  next.dispose(); assert.equal(typeof Object.getOwnPropertyDescriptor(f.ref, 'current').value, 'function');
});

test('React callback replacement releases the first callback and its captured state', () => {
  const moduleUrl = new URL('../src/runtime/native-autosave-idle-guard.js', import.meta.url).href;
  execFileSync(process.execPath, ['--max-old-space-size=128', '--expose-gc', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { installNativeAutosaveIdleGuard } from ${JSON.stringify(moduleUrl)};
    const replacement = () => 42;
    function fixture() {
      const payload = new Array(1000).fill(17);
      const callback = () => payload.length;
      const oldCallback = new WeakRef(callback), oldPayload = new WeakRef(payload);
      const ref = { current: callback };
      const guard = installNativeAutosaveIdleGuard({ ref });
      ref.current = replacement;
      return { guard, ref, oldCallback, oldPayload };
    }
    const current = fixture();
    for (let i = 0; i < 8; i++) { await setImmediate(); globalThis.gc(); }
    assert.equal(current.oldCallback.deref() === undefined, true, 'initial callback retained after React replaced it');
    assert.equal(current.oldPayload.deref() === undefined, true, 'initial callback retained its captured state');
    assert.equal(current.ref.current(), 42);
    current.guard.dispose();
    assert.equal(current.ref.current(), 42);
  `], { stdio: 'pipe', timeout: 15000 });
});

test('save activity records synchronous work and completion without changing native results', async () => {
  let clock = 0, finish;
  const nativePromise = new Promise(resolve => { finish = resolve; });
  const records = [], ref = { current() { clock += 30000; return nativePromise; } };
  const guard = installNativeAutosaveIdleGuard({ ref, now: () => clock,
    onActivity: (stage, details) => records.push({ stage, ...details }) });
  const result = ref.current();
  assert.equal(result, nativePromise);
  assert.deepEqual(records.map(row => row.stage), ['native-autosave.start', 'native-autosave.callback-return']);
  assert.equal(records[1].durationMs, 30000);
  clock += 2000; finish('saved');
  assert.equal(await result, 'saved');
  assert.equal(records.at(-1).stage, 'native-autosave.complete');
  assert.equal(records.at(-1).durationMs, 32000);
  guard.dispose();
});

test('diagnostic errors cannot fail an autosave and native errors retain their identity', async () => {
  const error = new Error('native failure');
  const ref = { current: () => { throw error; } };
  const guard = installNativeAutosaveIdleGuard({ ref, onActivity() { throw new Error('probe'); } });
  assert.throws(() => ref.current(), value => value === error);
  ref.current = () => Promise.reject(error);
  await assert.rejects(ref.current(), value => value === error);
  guard.dispose();
});
