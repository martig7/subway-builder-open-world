import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { cachedSimulationPosting } from '../src/runtime/cached-simulation-posting.js';
import { createHourlyPostingPreparation } from '../src/runtime/hourly-posting-preparation.js';
import { runFrameBudgeted } from '../src/runtime/frame-budget.js';

const input = { sessionId: 'one', profile: { hourly: Array.from({ length: 24 }, () => ({ revenue: 120,
  revenueByRoute: { r: 120 }, completedCommutes: [{ popId: 'p', origin: 'home', size: 100, stationRoutes: [] }] })) },
  expenses: { routeHourly: { r: Array(24).fill(60) } } };
function workerFixture() {
  const messages = []; let receive;
  const worker = { postMessage: data => receive({ data }), terminate() {} };
  const context = vm.createContext({ cachedSimulationPosting, postMessage(data) { messages.push(data); } });
  vm.runInContext(readFileSync(new URL('../src/workers/hourly-finance-worker.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, ''), context);
  receive = context.onmessage;
  return { worker, messages, deliver() { worker.onmessage({ data: messages.shift() }); } };
}

test('worker and fallback preserve exact partial-hour and midnight posting values', async () => {
  const f = workerFixture(), prepared = [];
  const service = createHourlyPostingPreparation({ createWorker: () => f.worker, prepareNative: async p => prepared.push(p) });
  service.setProfile(input);
  const pending = service.prepare(86300, 86500);
  assert.equal(service.take(86300, 86500), null);
  f.deliver(); await pending;
  const expected = { ...cachedSimulationPosting({ ...input, from: 86300, to: 86500 }), retainCommutesSince: 100 };
  assert.deepEqual(service.take(86300, 86500), expected);
  assert.equal(prepared.length, 1);
  assert.equal(service.take(86300, 86499), null);
  service.dispose();
});

test('late worker results cannot publish after profile replacement or disposal', async () => {
  const f = workerFixture(), service = createHourlyPostingPreparation({ createWorker: () => f.worker });
  service.setProfile(input); const old = service.prepare(0, 3600);
  service.setProfile({ ...input, sessionId: 'two' }); const next = service.prepare(0, 3600);
  f.deliver(); assert.equal(await old, null); assert.equal(service.take(0, 3600), null);
  f.deliver(); await next;
  assert.match(service.take(0, 3600).postingId, /:two:/);
  service.dispose(); assert.equal(service.take(0, 3600), null);
});

test('worker failure falls back to cancellable browser tasks', async () => {
  let yields = 0;
  const service = createHourlyPostingPreparation({ createWorker() { throw Error('unavailable'); },
    budget: { budgetMs: 0, yieldTask: async () => { yields++; } } });
  service.setProfile(input); await service.prepare(0, 3600);
  assert.ok(yields >= 2); assert.equal(service.snapshot().fallbacks, 1);
  assert.equal(service.take(0, 3600).revenue, 120);
  service.dispose();
});

test('frame budget yields a real browser task and closes cancelled work', async () => {
  let timerFired = false, closed = false;
  setTimeout(() => { timerFired = true; }, 0);
  const result = await runFrameBudgeted((function* () { try { yield; assert.ok(timerFired); yield; } finally { closed = true; } })(),
    { budgetMs: 0, cancelled: () => timerFired });
  assert.equal(result, null); assert.ok(timerFired); assert.ok(closed);
});

test('unresponsive workers time out and the same interval remains available synchronously', async () => {
  let terminated = 0;
  const service = createHourlyPostingPreparation({ timeoutMs: 5,
    createWorker: () => ({ postMessage() {}, terminate() { terminated++; } }) });
  service.setProfile(input);
  const pending = service.prepare(0, 3600);
  assert.equal(service.take(0, 3600), null);
  assert.equal(cachedSimulationPosting({ ...input, from: 0, to: 3600 }).revenue, 120);
  await pending;
  assert.equal(service.take(0, 3600).revenue, 120);
  assert.equal(terminated, 1); service.dispose();
});
