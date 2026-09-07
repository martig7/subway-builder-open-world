import test from 'node:test';
import assert from 'node:assert/strict';
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
  const result = f.ref.current();
  const next = installNativeAutosaveIdleGuard({ ref: f.ref, isMoving: () => false });
  await result; assert.equal(f.calls.length, 0);
  assert.notEqual(Object.getOwnPropertyDescriptor(f.ref, 'current').get, oldGetter);
  assert.equal(await f.ref.current(), 42);
  next.dispose(); assert.equal(typeof Object.getOwnPropertyDescriptor(f.ref, 'current').value, 'function');
});
