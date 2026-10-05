import test from 'node:test';
import assert from 'node:assert/strict';
import { demandContextRegistry } from '../src/runtime/demand-context.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = () => ({ version: 1, providerId: 'provider', definitionId: 'map', resolvedWorldId: 'world',
  tileId: 'A', cityCode: 'A', nativeSessionId: 'native', epoch: 1, demandRevision: 0, demandReady: true });
function fixture() {
  const root = {}, current = context();
  const registry = demandContextRegistry(root);
  const provider = { getContext: () => current, dispose() {} };
  const handle = registry.register('provider', provider);
  return { root, registry, current, provider, handle };
}

test('day delivery awaits async subscribers and uses elapsed-day indices without replay', async () => {
  const f = fixture(), gate = deferred(), events = [];
  assert.equal(f.registry.dayEventsVersion, 1);
  let settled = false;
  const unsubscribe = f.registry.subscribeDayChange(async event => { events.push(event); await gate.promise; });
  assert.deepEqual(events, []);
  const expected = f.registry.getContext();
  const publication = f.handle.publishDayChange(7, expected).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(events.length, 1); assert.equal(events[0].day, 7);
  assert.deepEqual(events[0].context, expected);
  gate.resolve();
  assert.equal((await publication).delivered, 1);
  unsubscribe(); await f.handle.publishDayChange(8, f.registry.getContext());
  assert.equal(events.length, 1);
});

test('normal revision and readiness changes do not discard a valid World day', async () => {
  const f = fixture(), events = [];
  const expected = f.registry.getContext();
  f.current.demandRevision++; f.current.demandReady = false;
  f.registry.subscribeDayChange(event => events.push(event));
  await f.handle.publishDayChange(1, expected);
  assert.equal(events.length, 1);
  assert.equal(events[0].context.demandReady, false);
  assert.equal(events[0].context.demandRevision, 1);
});

for (const [key, value] of [['resolvedWorldId', 'other-world'], ['nativeSessionId', 'other-save'],
  ['tileId', 'B'], ['epoch', 2]]) test(`a changed ${key} retires a captured day before delivery`, async () => {
  const f = fixture(), events = [], expected = f.registry.getContext();
  f.registry.subscribeDayChange(event => events.push(event)); f.current[key] = value;
  assert.equal((await f.handle.publishDayChange(1, expected)).status, 'superseded');
  assert.deepEqual(events, []);
});

test('provider replacement retires its old publisher even when other identity fields agree', async () => {
  const f = fixture(), events = [], expected = f.registry.getContext();
  f.registry.subscribeDayChange(event => events.push(event));
  const replacement = f.registry.register('provider', { ...f.provider });
  assert.equal((await f.handle.publishDayChange(1, expected)).status, 'superseded');
  assert.equal((await f.handle.publishDayChange(1, f.registry.getContext())).status, 'superseded');
  await replacement.publishDayChange(1, f.registry.getContext());
  assert.equal(events.length, 1); assert.equal(events[0].context.providerGeneration, expected.providerGeneration + 1);
});

test('an async subscriber cannot deliver the old World day into later subscribers after a load', async () => {
  const f = fixture(), gate = deferred(), events = [];
  f.registry.subscribeDayChange(async () => { await gate.promise; });
  f.registry.subscribeDayChange(event => events.push(event));
  const publication = f.handle.publishDayChange(1, f.registry.getContext());
  await Promise.resolve(); f.current.epoch++; gate.resolve();
  assert.equal((await publication).status, 'superseded'); assert.deepEqual(events, []);
});

test('one subscriber failure is reported without rejecting the clock or losing another subscriber', async t => {
  const f = fixture(), events = [], warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.registry.subscribeDayChange(async () => { throw new Error('checkpoint unavailable'); });
  f.registry.subscribeDayChange(event => events.push(event));
  const result = await f.handle.publishDayChange(1, f.registry.getContext());
  assert.equal(result.failed, 1); assert.equal(result.delivered, 1);
  assert.equal(events.length, 1); assert.equal(warnings.length, 1);
});

test('upgrading a frozen legacy v1 preserves provider generation, subscriptions and a pending handoff', async () => {
  // The previous public registry keeps these closures private and is frozen.
  const providers = new Map(), subscriptions = new Set(), handoffs = new Map();
  let generation = 0;
  const legacy = Object.freeze({ version: 1,
    getContext() { const token = providers.get('provider'); return token ? Object.freeze({ ...token.getContext(), providerGeneration: token.generation }) : null; },
    subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    readState(owner, expected) { return providers.get(expected.providerId).readState(owner, expected); },
    runMutation(owner, expected, mutation) {
      const token = providers.get(expected.providerId);
      return Promise.resolve(token.runMutation(owner, expected, mutation)).then(value => ({ ...value, providerGeneration: token.generation }));
    },
    register(id, provider) {
      const previous = providers.get(id);
      if (previous && previous.source !== provider) { provider.acceptHandoff?.(previous.exportHandoff?.()); previous.dispose?.(); }
      else if (!previous) provider.acceptHandoff?.(handoffs.get(id));
      handoffs.delete(id);
      const token = { ...provider, source: provider, generation: ++generation }; providers.set(id, token);
      for (const notify of subscriptions) notify();
      return { refresh() { if (providers.get(id) === token) for (const notify of subscriptions) notify(); },
        dispose() { if (providers.get(id) === token) { handoffs.set(id, token.exportHandoff?.()); providers.delete(id); token.dispose?.(); } } };
    },
  });
  const gate = deferred(), current = context(), operation = { mutationId: 'held-checkpoint' };
  const handoff = { operation, settled: gate.promise }, received = [];
  let disposed = 0, refreshes = 0;
  const oldHandle = legacy.register('provider', { getContext: () => current, readState: () => 'old-ledger',
    runMutation: () => gate.promise, exportHandoff: () => handoff, dispose() { disposed++; } });
  const expected = legacy.getContext(), pending = legacy.runMutation('induced', expected, operation);
  legacy.subscribe(() => { refreshes++; });
  const root = { SubwayBuilderOpenWorldDemand: legacy }, upgraded = demandContextRegistry(root);
  assert.notEqual(upgraded, legacy); assert.equal(upgraded.dayEventsVersion, 1);
  assert.strictEqual(demandContextRegistry(root), upgraded, 'feature upgrade never stacks facades');
  assert.deepEqual(upgraded.getContext(), expected);
  assert.equal(await upgraded.readState('induced', expected), 'old-ledger');
  assert.equal(disposed, 0, 'facade upgrade does not dispose the existing provider');
  oldHandle.refresh(); assert.equal(refreshes, 1);
  const handle = upgraded.register('provider', { getContext: () => current, acceptHandoff(value) { received.push(value); } });
  assert.strictEqual(received[0], handoff); assert.strictEqual(received[0].operation, operation);
  assert.equal(upgraded.getContext().providerGeneration, expected.providerGeneration + 1);
  assert.equal(disposed, 1);
  gate.resolve(current); assert.equal((await pending).providerGeneration, expected.providerGeneration);
  const events = []; upgraded.subscribeDayChange(event => events.push(event));
  await handle.publishDayChange(1, upgraded.getContext()); assert.equal(events.length, 1);
});
