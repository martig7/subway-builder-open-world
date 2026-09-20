import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileSimulationHandoff } from '../src/runtime/tile-simulation-handoff.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness({ enabled = true } = {}) {
  const calls = []; const scheduled = []; const listeners = new Set();
  let status = enabled ? 'ready' : 'off'; let hold; let owner = true;
  let enable = async () => { status = 'ready'; };
  let drain = async () => {};
  const simulation = {
    snapshot: () => ({ enabled, status }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setSuspended(value, options) { hold = value ? options : null; calls.push(value ? 'hold' : 'release'); },
    drainNativeWork: async () => { calls.push('drain'); await drain(); },
    async setEnabled(value) {
      calls.push(value ? 'enable' : 'disable');
      enabled = value;
      if (value && status !== 'ready') await enable();
      else if (!value) status = 'off';
      for (const listener of listeners) listener(simulation.snapshot());
      return simulation.snapshot();
    },
  };
  const handoff = createTileSimulationHandoff({ simulation, schedule: task => scheduled.push(task) });
  const transition = { tileId: 'B', transitionId: 'one' };
  const begin = async () => {
    await handoff.begin({ fromTileId: 'A', toTileId: 'B', nativeSessionId: 'session', isCurrent: () => owner });
    handoff.bind(transition);
  };
  return { calls, scheduled, simulation, handoff, begin, transition,
    changeOwner() { owner = false; },
    setEnable(fn) { enable = fn; }, setDrain(fn) { drain = fn; },
    markReady() { status = 'ready'; },
    isHeld: () => Boolean(hold?.isCurrent()),
    suppressesCommutes: () => Boolean(hold?.suppressCommutes && hold.isCurrent()),
    ready: finance => handoff.mapReady({ transition, isCurrent: () => owner, prepareFinance: finance }),
  };
}

test('transition holds the clock before disabling and drains native work before snapshot staging', async () => {
  const h = harness(); const drained = deferred(); h.setDrain(() => drained.promise);
  let staged = false;
  const start = h.begin().then(() => { staged = true; });
  await turn();
  assert.deepEqual(h.calls, ['hold', 'disable', 'drain']);
  assert.equal(h.isHeld(), true);
  assert.equal(h.suppressesCommutes(), true);
  assert.equal(staged, false);
  drained.resolve(); await start;
  assert.equal(h.handoff.mode.snapshot().enabled, true, 'the toggle shows preserved player intent');
});

test('map readiness precedes deferred destination assignments and finance; neither can release the clock early', async () => {
  const h = harness(); const assignments = deferred(); const finance = deferred();
  h.setEnable(async () => { h.calls.push('assignments'); await assignments.promise; h.markReady(); });
  await h.begin();
  const preparation = h.ready(async () => { h.calls.push('finance'); return finance.promise; });
  assert.equal(h.handoff.snapshot().status, 'queued');
  assert.ok(h.handoff.snapshot().mapReadyAt);
  assert.equal(h.calls.includes('assignments'), false);
  h.scheduled.shift()(); await turn();
  assert.equal(h.isHeld(), true); assert.equal(h.calls.includes('finance'), false);
  assignments.resolve(); await turn();
  assert.equal(h.calls.at(-1), 'finance'); assert.equal(h.isHeld(), true);
  finance.resolve({ status: 'recalculated' }); await preparation;
  assert.equal(h.isHeld(), false);
  assert.equal(h.handoff.snapshot().status, 'ready');
  assert.ok(h.handoff.snapshot().simulationReadyAt >= h.handoff.snapshot().mapReadyAt);
});

test('native mode preserves its intent and allows native commute repair while holding ticks', async () => {
  const h = harness({ enabled: false }); await h.begin();
  assert.equal(h.isHeld(), true); assert.equal(h.suppressesCommutes(), false);
  const preparation = h.ready(async () => ({ status: 'cached' }));
  h.scheduled.shift()(); await preparation;
  assert.equal(h.calls.includes('enable'), false);
  assert.equal(h.simulation.snapshot().enabled, false);
});

test('incomplete finance is retryable without preparing ready assignments again', async () => {
  const h = harness(); let calculations = 0; let attempts = 0;
  h.setEnable(async () => { calculations++; h.markReady(); });
  await h.begin();
  const first = h.ready(async () => ++attempts === 1
    ? { status: 'no-cross-demand', nativeFinanceProfile: { failed: ['B'], unavailable: [] } }
    : { status: 'cached' });
  h.scheduled.shift()(); await first;
  assert.equal(h.handoff.snapshot().status, 'error'); assert.equal(h.isHeld(), true);
  const retry = h.handoff.retry(); h.scheduled.shift()(); await retry;
  assert.equal(h.handoff.snapshot().status, 'ready');
  assert.equal(calculations, 1, 'a ready controller is reused on finance retry');
});

test('unrelated load cancels a queued handoff and never re-enables in the new session', async () => {
  const h = harness(); let finance = 0; await h.begin();
  const preparation = h.ready(async () => { finance++; return { status: 'cached' }; });
  h.changeOwner(); await h.handoff.cancel();
  h.scheduled.shift()(); await preparation;
  assert.equal(h.calls.includes('enable'), false); assert.equal(finance, 0);
  assert.equal(h.isHeld(), false); assert.equal(h.handoff.isPending(), false);
});

test('a late finance result cannot resume a cancelled handoff', async () => {
  const h = harness({ enabled: false }); const finance = deferred(); await h.begin();
  const preparation = h.ready(() => finance.promise); h.scheduled.shift()(); await turn();
  h.changeOwner(); await h.handoff.cancel();
  finance.resolve({ status: 'cached' }); await preparation;
  assert.equal(h.handoff.snapshot().status, 'cancelled');
  assert.equal(h.simulation.snapshot().enabled, false);
});
