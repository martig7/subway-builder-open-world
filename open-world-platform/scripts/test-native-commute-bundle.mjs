// node scripts/test-native-commute-bundle.mjs <renderer index> <pop commute worker>
// Executes AST-selected shipped pool, batching and message handler only. Routing
// is a controlled asynchronous seam; no game imports or startup code are run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import { installNativeCommuteWorkerBudget } from '../src/runtime/native-commute-worker-budget.js';
import { createCachedSimulation } from '../src/runtime/cached-simulation.js';
import { NativeCommuteIndex } from '../src/runtime/native-commute-index.js';

const [rendererInput, workerInput] = process.argv.slice(2);
if (!rendererInput || !workerInput) throw Error('Provide the extracted renderer index and pop commute worker');
async function inspect(input) {
  const path = resolve(input), source = await readFile(path, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const text = node => source.slice(node.start, node.end);
  return { path, source, ast, text, sha256: createHash('sha256').update(source).digest('hex'),
    functions: new Map(ast.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, node])),
    declarations: ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : []) };
}
const [renderer, worker] = await Promise.all([inspect(rendererInput), inspect(workerInput)]);
function isolate(bundle, globals) {
  const context = vm.createContext(globals);
  const evaluate = code => new vm.Script(code, { filename: bundle.path }).runInContext(context, { timeout: 5000 });
  const decoders = [];
  for (const node of bundle.ast.body) {
    if (node.type === 'FunctionDeclaration' && /^_0x/.test(node.id.name)) decoders.push(bundle.text(node));
    else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
      && node.expression.callee.type === 'FunctionExpression'
      && /parseInt\(/.test(bundle.text(node)) && /shift/.test(bundle.text(node)) && /while/.test(bundle.text(node))) {
      decoders.push(bundle.text(node));
    } else if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) if (declaration.id.type === 'Identifier' && /^_0x/.test(declaration.id.name)
        && declaration.init?.type === 'Identifier' && /^_0x/.test(declaration.init.name)) {
        decoders.push(`${node.kind} ${bundle.text(declaration)};`);
      }
    }
  }
  evaluate(decoders.join('\n'));
  const loadFunction = name => {
    const node = bundle.functions.get(name); assert.ok(node, `Missing shipped function ${name}`);
    evaluate(bundle.text(node));
  };
  return { context, evaluate, loadFunction };
}
const quiet = Object.fromEntries(['info', 'warn', 'error'].map(name => [name, () => {}]));
const step = () => new Promise(resolve => setImmediate(resolve));
function harness(withBudget) {
  const nativeWorkers = [], pending = [], inputs = [], timers = new Map(); let timerId = 0;
  class NativeWorker extends EventTarget {
    constructor(url, options) {
      super(); this.url = url; this.options = options; nativeWorkers.push(this);
      const scope = isolate(worker, { Error, Map, Set, performance, DEBUG_COMMUTE_SIM_TIMES: false, logger: quiet,
        self: { postMessage: data => queueMicrotask(() => {
          if (this.terminated) return;
          const event = new MessageEvent('message', { data: structuredClone(data) });
          this.dispatchEvent(event); this.onmessage?.(event);
        }) }, processPopCommuteBatch: input => {
          inputs.push(structuredClone(input));
          return new Promise((resolve, reject) => pending.push({ input, finish: () => input.fail
            ? reject(new Error('controlled routing failure')) : resolve({ processedPops: input.popCommutes.map(row => ({
              popId: row.popId, updatedPop: input.pops?.find(pop => pop.id === row.popId) ?? { id: row.popId },
              popMovement: null, demandPointIds: [], networkLabel: input.network.label,
            })) }) }));
        } });
      scope.loadFunction('isSetNetworkMessage');
      const network = worker.declarations.find(node => node.id.name === 'sharedNetwork');
      assert.ok(network); scope.evaluate(`var ${worker.text(network)};`);
      const handler = worker.ast.body.find(node => node.type === 'ExpressionStatement'
        && node.expression.type === 'AssignmentExpression' && node.expression.left.type === 'MemberExpression'
        && node.expression.left.object.name === 'self' && node.expression.right.type === 'ArrowFunctionExpression');
      assert.ok(handler, 'Missing shipped worker message handler');
      scope.evaluate(worker.text(handler)); this.handler = scope.context.self.onmessage;
    }
    postMessage(data) { void this.handler({ data: structuredClone(data) }); }
    terminate() { this.terminated = true; }
  }
  const root = { Worker: NativeWorker, EventTarget, Event, MessageEvent, structuredClone,
    navigator: { hardwareConcurrency: 24 },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  const budget = withBudget ? installNativeCommuteWorkerBudget({ root, now: () => 1000 }) : null;
  const index = isolate(renderer, { Error, Map, Set, performance, navigator: root.navigator,
    WorkerWrapper$1: function () { return new root.Worker(pathToFileURL(worker.path), { type: 'module' }); },
    DEBUG_COMMUTE_SIM_TIMES: false, DEBUG_TIMES: false, logger: quiet,
    window: { electronAPI: { buildRaptorNetwork: async () => ({ success: true, network: { label: 'native-network' } }) } },
    buildJourneyFareIndex: () => ({}), convertToRaptorFormat: () => ({ stops: [], raptorRoutes: [] }),
    createDebugTimings: () => ({}), addToDebugTiming() {}, isFeatureEnabled: () => false,
    PATHFINDING_RULES: {}, addDisplayModeChoice() {} });
  const poolNode = renderer.ast.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'WorkerPool');
  assert.ok(poolNode, 'Missing shipped WorkerPool');
  index.evaluate(`${renderer.text(poolNode)}; globalThis.NativeWorkerPool = WorkerPool;`);
  const pool = new index.context.NativeWorkerPool();
  index.context.getWorkerPool = () => pool;
  index.loadFunction('simulatePopCommutes');
  const settle = async promise => {
    let done = false; promise.then(() => { done = true; }, () => { done = true; });
    for (let round = 0; !done && round < 100; round++) {
      await step();
      if (pending.length) pending.pop().finish();
      else assert.ok(done, 'A shipped pool task was stranded without a terminal response');
    }
    assert.ok(done, 'Shipped pool completion limit exceeded'); return promise;
  };
  return { root, budget, nativeWorkers, pending, inputs, timers, pool, index, settle };
}

const summaries = [];
for (const withBudget of [false, true]) {
  const f = harness(withBudget);
  assert.equal(f.nativeWorkers.length, withBudget ? 0 : 24, 'The native pool still eagerly constructs one worker per logical CPU');
  const pops = Array.from({ length: 424 }, (_, id) => ({ id: `p${id}`, residenceId: 'home', jobId: 'work' }));
  const resultPromise = f.index.context.simulatePopCommutes({ routes: [], stations: [], trains: [],
    popsMap: new Map(pops.map(pop => [pop.id, pop])), demandPoints: new Map(), elapsedSeconds: 900, transitCost: 3 },
  pops.map(pop => ({ popId: pop.id, direction: 'homeToWork' })));
  await step();
  assert.equal(f.pending.length, withBudget ? 6 : 7, 'Shipped dispatch concurrency and mod budget remain independent');
  if (withBudget) assert.equal(f.budget.snapshot().queued, 1);
  const result = await f.settle(resultPromise);
  assert.deepEqual(Array.from(result.processedPops, row => row.popId), pops.map(pop => pop.id),
    'Native batching preserves results in input order despite out-of-order completion');
  assert.deepEqual(f.inputs.map(input => input.popCommutes.length), [50, 50, 50, 50, 50, 50, 50, 74]);
  assert.ok(f.inputs.every(input => input.network.label === 'native-network'));
  if (withBudget) {
    assert.equal(f.budget.snapshot().networkClones, 1);
    const first = f.pool.executeParallel([{ popCommutes: [{ popId: 'a' }] }], { label: 'network-a' });
    const second = f.pool.executeParallel([{ popCommutes: [{ popId: 'b' }] }], { label: 'network-b' });
    const paired = await f.settle(Promise.all([first, second]));
    assert.deepEqual(paired.map(rows => rows[0].processedPops[0].networkLabel), ['network-a', 'network-b']);
    const failure = f.pool.executeParallel([{ popCommutes: [], fail: true }], { label: 'failure-network' });
    await assert.rejects(f.settle(failure), /controlled routing failure/);
    assert.equal(f.budget.snapshot().busy, 0, 'batchError is a terminal response and must release the physical slot');
    for (const callback of [...f.timers.values()]) callback();
    assert.equal(f.budget.snapshot().workers, 0, 'Idle native routing heaps must be released');
  }
  summaries.push({ budgeted: withBudget, logicalWorkers: 24, constructedPhysicalWorkers: f.nativeWorkers.length,
    simultaneousBatches: withBudget ? 6 : 7, batchSizes: [50, 50, 50, 50, 50, 50, 50, 74], processedPops: result.processedPops.length });
  f.pool.terminate();
}

// Run the native detached-wave queue and its actual publication action through
// cached-mode activation. Only the awaited routing response and UI/diagnostic
// callbacks are stubs. Demand merging and native queue ownership are shipped.
const native = isolate(renderer, { Error, Map, Set, performance, logger: quiet,
  DEBUG_COMMUTE_SIM_TIMES: false, DEBUG_TIMES: false, SECONDS_IN_DAY: 86400, RULES: { COMMUTE_INTERVAL_LENGTH: 900 },
  isDebugToolOn: () => false, getPopMovementGeojson: () => ({ type: 'FeatureCollection', features: [] }),
  triggerDemandChange() {}, recordTick() {}, simulateCommutesTimes: [] });
const store = renderer.declarations.find(node => node.id.name === 'useMainStore')?.init?.arguments?.[0];
assert.equal(store?.body?.type, 'ObjectExpression', 'Missing shipped store factory');
const methods = new Map(store.body.properties.filter(node => node.type === 'Property')
  .map(node => [node.key.value ?? node.key.name, node.value]));
for (const name of ['pendingCommutePops', 'queuedCommutePopIds', 'commuteWaveInFlight', 'precomputedCommuteCoverage']) {
  const value = renderer.declarations.find(node => node.id.name === name);
  assert.ok(value, `Missing shipped commute queue state ${name}`);
  native.evaluate(`var ${renderer.text(value)};`);
}
let finishNative, preparations = 0;
native.context.simulatePopCommutes = () => new Promise(resolve => { finishNative = resolve; });
const pop = { id: 'native-pop', size: 1, residenceId: 'home', jobId: 'work' };
const state = { gameSessionId: 'native-session', cityCode: 'native-tile', routes: [], trains: [], stations: [],
  tracks: [], trackGroups: [], fareGroups: [], transitCost: 3, popMovementsMap: new Map(),
  timeConfig: { elapsedSeconds: 900, timeSpeed: 'normal', paused: true },
  demandData: { popsMap: new Map([[pop.id, pop]]), points: new Map() },
  handleIncrementGameState() {}, calculatePaths() {}, generateSave() { return { data: {} }; },
  setTimeConfig(update) { this.timeConfig = { ...this.timeConfig, ...update }; },
  setDemandData(value) { this.demandData = value; }, setTrains(value) { this.trains = value; },
  setPopMovementsMap(value) { this.popMovementsMap = value; }, setAllStationTrainPopMovements() {}, setPopMovementGeojson() {},
};
native.context[store.params[0].name] = update => Object.assign(state, update);
native.context[store.params[1].name] = () => state;
for (const name of ['startCommuteWave', 'simulateCommutes', 'prepareNextCommuteWave', 'setCompletedCommutes']) {
  assert.ok(methods.has(name), `Missing shipped action ${name}`);
  state[name] = native.evaluate(`(${renderer.text(methods.get(name))})`);
}
const cached = createCachedSimulation({ getState: () => state, api: { utils: {} },
  game: { captureCrossTileNetworkProfile: () => ({}), calculateNativeFinanceProfile: () => ({ expenseProfile: {} }),
    postBackgroundNativeFinanceNow: () => ({ applied: true }) }, evaluate: async () => {
    preparations++;
    const commute = { modeChoice: { walking: 0, driving: 0, transit: 0, unknown: 1 }, transitPaths: [] };
    return { assignments: [{ ...pop, cachedAssignment: true, commutes: { homeToWork: commute, workToHome: commute } }],
      profile: { hourly: Array.from({ length: 24 }, () => ({ revenue: 0, completedCommutes: [] })) } };
  } });
assert.equal(state.startCommuteWave([{ popId: pop.id, direction: 'homeToWork' }]), undefined,
  'Native v1.7.2 wave launch is detached from the tick');
assert.equal(cached.snapshot().saveWork.native, 1, 'The mod observes the real native detached action');
const enabling = cached.setEnabled(true);
await step();
assert.equal(preparations, 0, 'Cached activation must await native publication');
finishNative({ processedPops: [{ popId: pop.id, updatedPop: { ...pop, nativeWavePublished: true }, popMovement: null }],
  newDemandPoints: new Map(), recountedPointIds: [] });
await enabling;
assert.equal(preparations, 1);
assert.equal(state.demandData.popsMap.get(pop.id).nativeWavePublished, true);
assert.equal(state.demandData.popsMap.get(pop.id).cachedAssignment, true,
  'Cached assignment publishes after the shipped native wave');
await cached.dispose();

native.loadFunction('selectCommuteWindowPops');
const daySeconds = renderer.declarations.find(node => node.id.name === 'SECONDS_IN_DAY$2');
assert.ok(daySeconds); native.evaluate(`var ${renderer.text(daySeconds)};`);
const departures = new Map([
  ['home', { id: 'home', homeDepartureTime: 86370, workDepartureTime: 40000 }],
  ['work', { id: 'work', homeDepartureTime: 40000, workDepartureTime: 60 }],
  ['outside', { id: 'outside', homeDepartureTime: 901, workDepartureTime: 2000 }],
  ['travelling', { id: 'travelling', homeDepartureTime: 86370, workDepartureTime: 60 }],
  ['boundary', { id: 'boundary', homeDepartureTime: 600, workDepartureTime: 40000 }],
]);
const selection = native.context.selectCommuteWindowPops({ popsMap: departures,
  popMovementsMap: new Map([['travelling', {}]]), windowStartDaySeconds: 86100, intervalLength: 900 });
assert.deepEqual(Array.from(selection, row => [row.popId, row.direction]),
  [['home', 'homeToWork'], ['work', 'workToHome'], ['boundary', 'homeToWork']],
  'Native lookahead handles midnight wrap, both directions, the exact window boundary and existing journeys');
state.demandData.popsMap = departures; state.popMovementsMap = new Map([['travelling', {}]]);
let preparedWave;
state.startCommuteWave = (...args) => { preparedWave = args; };
state.prepareNextCommuteWave(86100);
assert.equal(preparedWave[1], 86100, 'Lookahead routing retains the absolute future departure time');
assert.deepEqual(Array.from(preparedWave[0], row => [row.popId, row.direction]),
  Array.from(selection, row => [row.popId, row.direction]));

// Lookahead changes departure assignment; the retained-receipt index has a
// separate source seam. Verify the shipped setter still publishes immutable
// array/record references and a later native publication forces index rebuild.
let idReads = 0;
const nativeReceipt = { journeyEnd: 1000, journeyStart: 900, size: 1 };
Object.defineProperty(nativeReceipt, 'popId', { enumerable: true, get() { idReads++; return 'native-receipt'; } });
state.completedCommutes = [nativeReceipt]; state.lastStatsUpdateTime = 0;
const receipts = new NativeCommuteIndex();
const modReceipt = { popId: 'mod-receipt', journeyEnd: 1100, size: 2 };
let merged = receipts.merge({ records: state.completedCommutes, sessionId: state.gameSessionId,
  elapsedSeconds: 900, incoming: [modReceipt] });
state.setCompletedCommutes(merged.records);
assert.equal(state.completedCommutes, merged.records);
assert.equal(state.completedCommutesFor15MinStats, merged.records);
assert.equal(state.completedCommutes[0], nativeReceipt);
idReads = 0;
merged = receipts.merge({ records: state.completedCommutes, sessionId: state.gameSessionId,
  elapsedSeconds: 901, incoming: [modReceipt] });
assert.equal(idReads, 0, 'Stable native receipt arrays must still reuse the mod index');
assert.equal(merged.records, state.completedCommutes, 'Duplicate mod receipt does not publish another array');
state.setCompletedCommutes([...state.completedCommutes, { popId: 'new-native-receipt', journeyEnd: 1200, size: 3 }]);
merged = receipts.merge({ records: state.completedCommutes, sessionId: state.gameSessionId,
  elapsedSeconds: 1200, retainSince: 1100, incoming: [{ popId: 'new-native-receipt', journeyEnd: 1200, size: 3 }] });
assert.ok(idReads > 0, 'A native wave receipt-array replacement must rebuild the disposable mod index');
assert.deepEqual(merged.records.map(row => row.popId), ['mod-receipt', 'new-native-receipt']);
assert.equal(merged.expired, 1);
console.log(JSON.stringify({ renderer: { path: renderer.path, sha256: renderer.sha256 },
  worker: { path: worker.path, sha256: worker.sha256 }, routing: 'controlled asynchronous seam; not under test',
  summaries, nativeDetachedWaveDrainedBeforeCachedActivation: true, nativeLookaheadWindowVerified: true,
  completedReceiptIndexCompatibleWithNativeSetter: true }, null, 2));
console.log('PASS: shipped pool/protocol, ordering, idle retirement, cached activation, lookahead selection and completed-receipt indexing');
