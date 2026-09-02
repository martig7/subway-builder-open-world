import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSimulationPerformanceDiagnostics,
  prepareSimulationPerformanceDiagnostics,
  sampleSimulationThroughput,
  SIMULATION_PERF_VERSION,
} from '../../../../open-world-platform/src/runtime/simulation-performance-diagnostics.js';

function fixture() {
  const state = {
    timeConfig: { elapsedSeconds: 0, timeSpeed: 'ultrafast', isPaused: false },
    routes: [{ id: 'route-a' }],
    trains: [{ id: 'train-a' }],
    stations: [{ id: 'station-a' }],
    tracks: new Map([['track-a', {}]]),
    setTimeConfig() {},
  };
  const nativeSimulateCommutes = async ({ popCommutes }) => popCommutes.length;
  const nativeCalculatePaths = async () => 'paths';
  const nativeTick = async () => {
    await state.simulateCommutes({ popCommutes: [{ id: 'commute-a' }], startMovements: true });
    await state.calculatePaths({ popCommutes: [{ id: 'commute-a' }] });
    state.timeConfig.elapsedSeconds += 600;
    return 'tick';
  };
  state.simulateCommutes = nativeSimulateCommutes;
  state.calculatePaths = nativeCalculatePaths;
  state.handleIncrementGameState = nativeTick;
  const callbacks = { getState: () => state };
  return { state, callbacks, nativeTick, nativeSimulateCommutes, nativeCalculatePaths };
}

function disableAndRestore(callbacks) {
  globalThis.__enableOpenWorldSimulationPerfDebug?.(false);
  prepareSimulationPerformanceDiagnostics(callbacks);
}

test('profiles native simulation stages and achieved game speed only when enabled', async (t) => {
  const testFixture = fixture();
  t.after(() => disableAndRestore(testFixture.callbacks));

  const installed = installSimulationPerformanceDiagnostics(testFixture.callbacks);
  assert.equal(installed.version, SIMULATION_PERF_VERSION);
  assert.equal(testFixture.state.handleIncrementGameState, testFixture.nativeTick,
    'disabled diagnostics must not add per-tick wrapper overhead');
  assert.equal(typeof globalThis.__enableOpenWorldSimulationPerfDebug, 'function');
  assert.equal(typeof globalThis.__printOpenWorldSimulationPerfDiagnostic, 'function');
  assert.equal(typeof globalThis.__clearOpenWorldSimulationPerfDiagnostic, 'function');

  const status = globalThis.__enableOpenWorldSimulationPerfDebug({
    reset: true,
    quiet: true,
    slowMs: Number.MAX_SAFE_INTEGER,
    sampleIntervalMs: 1_000,
  });
  assert.equal(status.enabled, true);
  assert.deepEqual(status.probes.installed.sort(), [
    'calculatePaths',
    'handleIncrementGameState',
    'simulateCommutes',
  ]);

  assert.equal(await testFixture.state.handleIncrementGameState(), 'tick');
  const throughputSample = sampleSimulationThroughput();
  assert.ok(throughputSample.wallMilliseconds > 0);
  assert.equal(throughputSample.gameSeconds, 600);
  assert.ok(throughputSample.gameSecondsPerWallSecond > 0);

  const report = globalThis.__printOpenWorldSimulationPerfDiagnostic();
  assert.equal(report.version, SIMULATION_PERF_VERSION);
  assert.equal(report.stages['simulation.tick.total'].count, 1);
  assert.equal(report.stages['simulation.commutes'].count, 1);
  assert.equal(report.stages['simulation.paths'].count, 1);
  assert.equal(report.ticks[0].gameSecondsAdvanced, 600);
  assert.equal(report.ticks[0].routes, 1);
  assert.equal(report.throughput.sampleCount, 1);
  assert.equal(report.throughput.totalGameSeconds, 600);

  globalThis.__clearOpenWorldSimulationPerfDiagnostic();
  const cleared = globalThis.__printOpenWorldSimulationPerfDiagnostic();
  assert.equal(cleared.ticks.length, 0);
  assert.equal(cleared.samples.length, 0);
  assert.deepEqual(cleared.stages, {});

  globalThis.__enableOpenWorldSimulationPerfDebug(false);
  assert.equal(testFixture.state.handleIncrementGameState, testFixture.nativeTick,
    'disabling diagnostics must restore the native action');
  assert.equal(testFixture.state.simulateCommutes, testFixture.nativeSimulateCommutes);
  assert.equal(testFixture.state.calculatePaths, testFixture.nativeCalculatePaths);
});

test('hot reload removes an older profiler wrapper before installing the current generation', (t) => {
  const testFixture = fixture();
  t.after(() => disableAndRestore(testFixture.callbacks));
  installSimulationPerformanceDiagnostics(testFixture.callbacks);
  globalThis.__enableOpenWorldSimulationPerfDebug(false);

  const probe = Symbol.for('open-world.simulation-perf-probe');
  const version = Symbol.for('open-world.simulation-perf-probe-version');
  const original = Symbol.for('open-world.simulation-perf-probe-original');
  const staleWrapper = (...args) => testFixture.nativeTick(...args);
  Object.defineProperties(staleWrapper, {
    [probe]: { value: true },
    [version]: { value: 'open-world-simulation-perf-v0' },
    [original]: { value: testFixture.nativeTick },
  });
  testFixture.state.handleIncrementGameState = staleWrapper;

  assert.deepEqual(prepareSimulationPerformanceDiagnostics(testFixture.callbacks), {
    restored: ['handleIncrementGameState'],
  });
  assert.equal(testFixture.state.handleIncrementGameState, testFixture.nativeTick);

  installSimulationPerformanceDiagnostics(testFixture.callbacks);
  globalThis.__enableOpenWorldSimulationPerfDebug({ reset: true, quiet: true });
  assert.notEqual(testFixture.state.handleIncrementGameState, staleWrapper);
  assert.equal(testFixture.state.handleIncrementGameState[version], SIMULATION_PERF_VERSION);
  assert.equal(testFixture.state.handleIncrementGameState[original], testFixture.nativeTick);
});
