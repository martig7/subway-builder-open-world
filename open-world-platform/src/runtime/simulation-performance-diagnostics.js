const SIMULATION_PERF_VERSION = 'open-world-simulation-perf-v1';
const SIMULATION_PERF_PREFIX = '[OpenWorld simulation perf]';
const SIMULATION_PERF_STATE = '__openWorldSimulationPerfStateV1__';
const SIMULATION_PERF_RUNTIME = '__openWorldSimulationPerfRuntimeV1__';
const SIMULATION_PERF_FLAG = '__openWorldSimulationPerfEnabled__';
const SIMULATION_PERF_PROBE = Symbol.for('open-world.simulation-perf-probe');
const SIMULATION_PERF_PROBE_VERSION = Symbol.for('open-world.simulation-perf-probe-version');
const SIMULATION_PERF_PROBE_ORIGINAL = Symbol.for('open-world.simulation-perf-probe-original');
const SIMULATION_PERF_PROBE_BINDING = Symbol.for('open-world.simulation-perf-probe-binding');

const PROBE_ACTIONS = Object.freeze({
  handleIncrementGameState: 'simulation.tick.total',
  simulateCommutes: 'simulation.commutes',
  calculatePaths: 'simulation.paths',
  updateMultipleGameState: 'simulation.update-multiple-game-state',
});

function perfNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampOption(value, fallback, minimum = 0) {
  const number = finiteNumber(value);
  return number == null ? fallback : Math.max(minimum, number);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function rounded(value) {
  return Number(finiteNumber(value, 0).toFixed(3));
}

function newSimulationPerfState({ slowMs = 16, sampleIntervalMs = 1_000, quiet = true } = {}) {
  return {
    version: SIMULATION_PERF_VERSION,
    createdAt: Date.now(),
    quiet: quiet !== false,
    slowMs: clampOption(slowMs, 16),
    sampleIntervalMs: clampOption(sampleIntervalMs, 1_000, 100),
    nextTickId: 1,
    stages: {},
    ticks: [],
    throughputSamples: [],
    slowEvents: [],
    probes: [],
  };
}

function simulationPerfState() {
  const existing = globalThis[SIMULATION_PERF_STATE];
  if (!existing || existing.version !== SIMULATION_PERF_VERSION) {
    globalThis[SIMULATION_PERF_STATE] = newSimulationPerfState();
  }
  return globalThis[SIMULATION_PERF_STATE];
}

function simulationPerfEnabled() {
  return globalThis[SIMULATION_PERF_FLAG] === true;
}

function simulationPerfRuntime() {
  return globalThis[SIMULATION_PERF_RUNTIME] ?? null;
}

function readState(callbacks) {
  try { return callbacks?.getState?.() ?? null; } catch { return null; }
}

function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  const size = finiteNumber(value?.size);
  return size == null ? null : size;
}

function stateDetails(state) {
  const timeConfig = state?.timeConfig ?? {};
  return {
    elapsedSeconds: finiteNumber(timeConfig.elapsedSeconds),
    timeSpeed: timeConfig.timeSpeed ?? timeConfig.speed ?? null,
    speedMultiplier: finiteNumber(timeConfig.speedMultiplier),
    paused: timeConfig.isPaused === true || timeConfig.paused === true,
    routes: collectionSize(state?.routes),
    trains: collectionSize(state?.trains),
    stations: collectionSize(state?.stations),
    tracks: collectionSize(state?.tracks),
  };
}

function actionDetails(actionName, args, state) {
  const details = stateDetails(state);
  if (actionName === 'simulateCommutes' || actionName === 'calculatePaths') {
    details.popCommutes = collectionSize(args?.[0]?.popCommutes);
    details.startMovements = args?.[0]?.startMovements ?? null;
  }
  return details;
}

function appendLimited(values, value, limit) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function recordStage(stage, durationMs, details = {}) {
  if (!simulationPerfEnabled()) return;
  const duration = finiteNumber(durationMs);
  if (duration == null) return;
  const state = simulationPerfState();
  const stats = state.stages[stage] ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    slowCount: 0,
    samples: [],
  };
  stats.count += 1;
  stats.totalMs += duration;
  stats.maxMs = Math.max(stats.maxMs, duration);
  stats.lastMs = duration;
  if (duration >= state.slowMs) stats.slowCount += 1;
  appendLimited(stats.samples, duration, 1_000);
  state.stages[stage] = stats;
  if (duration < state.slowMs) return;
  const event = {
    at: Date.now(),
    stage,
    durationMs: duration,
    ...details,
  };
  appendLimited(state.slowEvents, event, 240);
  if (!state.quiet && (stats.slowCount <= 5 || stats.slowCount % 20 === 0)) {
    console.warn(SIMULATION_PERF_PREFIX, 'slow-stage', event);
  }
}

function finalizeAction(binding, startedAt, args, tickId, status, error = null) {
  const durationMs = perfNow() - startedAt;
  const after = actionDetails(binding.actionName, args, readState(binding.callbacks));
  const details = {
    tickId,
    status,
    ...(error ? { error: String(error?.message ?? error) } : {}),
    ...after,
  };
  recordStage(binding.stage, durationMs, details);
  if (binding.actionName !== 'handleIncrementGameState') return;

  const state = simulationPerfState();
  const gameSecondsAdvanced = after.elapsedSeconds != null && binding.beforeElapsedSeconds != null
    ? after.elapsedSeconds - binding.beforeElapsedSeconds
    : null;
  const tick = {
    id: tickId,
    capturedAt: Date.now(),
    durationMs,
    gameSecondsAdvanced,
    gameSecondsPerComputeSecond: gameSecondsAdvanced != null && durationMs > 0
      ? gameSecondsAdvanced / (durationMs / 1_000)
      : null,
    ...details,
  };
  appendLimited(state.ticks, tick, 500);
  const runtime = simulationPerfRuntime();
  if (runtime?.activeTickId === tickId) runtime.activeTickId = null;
}

function wrapAction(original, actionName, stage, callbacks) {
  const binding = { actionName, stage, callbacks, beforeElapsedSeconds: null };
  const wrapped = function openWorldSimulationPerfProbe(...args) {
    if (!simulationPerfEnabled()) return original.apply(this, args);
    const runtime = simulationPerfRuntime();
    const isTick = actionName === 'handleIncrementGameState';
    const tickId = isTick
      ? `tick-${simulationPerfState().nextTickId++}`
      : runtime?.activeTickId ?? null;
    if (isTick) {
      runtime.activeTickId = tickId;
      binding.beforeElapsedSeconds = stateDetails(readState(binding.callbacks)).elapsedSeconds;
    }
    const startedAt = perfNow();
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      finalizeAction(binding, startedAt, args, tickId, 'threw', error);
      throw error;
    }
    if (!result || typeof result.then !== 'function') {
      finalizeAction(binding, startedAt, args, tickId, 'completed');
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        finalizeAction(binding, startedAt, args, tickId, 'completed');
        return value;
      },
      (error) => {
        finalizeAction(binding, startedAt, args, tickId, 'rejected', error);
        throw error;
      },
    );
  };
  Object.defineProperties(wrapped, {
    [SIMULATION_PERF_PROBE]: { value: true },
    [SIMULATION_PERF_PROBE_VERSION]: { value: SIMULATION_PERF_VERSION },
    [SIMULATION_PERF_PROBE_ORIGINAL]: { value: original },
    [SIMULATION_PERF_PROBE_BINDING]: { value: binding },
  });
  return wrapped;
}

function unwrapSimulationProbe(action) {
  let current = action;
  const seen = new Set();
  while (typeof current === 'function' && current[SIMULATION_PERF_PROBE]
    && typeof current[SIMULATION_PERF_PROBE_ORIGINAL] === 'function'
    && !seen.has(current)) {
    seen.add(current);
    current = current[SIMULATION_PERF_PROBE_ORIGINAL];
  }
  return current;
}

function stopSampler(runtime = simulationPerfRuntime()) {
  if (runtime?.timer != null) globalThis.clearInterval?.(runtime.timer);
  if (runtime) {
    runtime.timer = null;
    runtime.sampleBaseline = null;
    runtime.activeTickId = null;
  }
}

export function prepareSimulationPerformanceDiagnostics(callbacks) {
  const previous = simulationPerfRuntime();
  stopSampler(previous);
  const state = readState(callbacks ?? previous?.callbacks);
  const restored = [];
  for (const actionName of Object.keys(PROBE_ACTIONS)) {
    const current = state?.[actionName];
    if (typeof current !== 'function' || !current[SIMULATION_PERF_PROBE]) continue;
    state[actionName] = unwrapSimulationProbe(current);
    restored.push(actionName);
  }
  if (previous) previous.probes = [];
  simulationPerfState().probes = [];
  if (restored.length) state?.setTimeConfig?.({});
  return { restored };
}

function installProbes(runtime = simulationPerfRuntime()) {
  const state = readState(runtime?.callbacks);
  if (!state) return { installed: [], reused: [], unavailable: Object.keys(PROBE_ACTIONS) };
  const installed = [];
  const reused = [];
  const unavailable = [];
  let changed = false;
  for (const [actionName, stage] of Object.entries(PROBE_ACTIONS)) {
    const current = state[actionName];
    if (typeof current !== 'function') {
      unavailable.push(actionName);
      continue;
    }
    if (current[SIMULATION_PERF_PROBE]
      && current[SIMULATION_PERF_PROBE_VERSION] === SIMULATION_PERF_VERSION) {
      const binding = current[SIMULATION_PERF_PROBE_BINDING];
      if (binding) binding.callbacks = runtime.callbacks;
      reused.push(actionName);
      continue;
    }
    state[actionName] = wrapAction(unwrapSimulationProbe(current), actionName, stage, runtime.callbacks);
    installed.push(actionName);
    changed = true;
  }
  runtime.probes = [...installed, ...reused];
  simulationPerfState().probes = [...runtime.probes];
  if (changed) state.setTimeConfig?.({});
  return { installed, reused, unavailable };
}

export function sampleSimulationThroughput() {
  const runtime = simulationPerfRuntime();
  if (!runtime || !simulationPerfEnabled()) return null;
  installProbes(runtime);
  const capturedAt = perfNow();
  const details = stateDetails(readState(runtime.callbacks));
  const baseline = runtime.sampleBaseline;
  runtime.sampleBaseline = { capturedAt, elapsedSeconds: details.elapsedSeconds };
  if (!baseline || baseline.elapsedSeconds == null || details.elapsedSeconds == null) return null;
  const wallMilliseconds = capturedAt - baseline.capturedAt;
  if (!(wallMilliseconds > 0)) return null;
  const gameSeconds = details.elapsedSeconds - baseline.elapsedSeconds;
  const clockReset = gameSeconds < 0;
  const sample = {
    capturedAt: Date.now(),
    wallMilliseconds,
    gameSeconds,
    gameSecondsPerWallSecond: clockReset ? null : gameSeconds / (wallMilliseconds / 1_000),
    schedulerDelayMs: Math.max(0, wallMilliseconds - simulationPerfState().sampleIntervalMs),
    clockReset,
    ...details,
  };
  appendLimited(simulationPerfState().throughputSamples, sample, 600);
  return sample;
}

function startSampler(runtime = simulationPerfRuntime()) {
  stopSampler(runtime);
  if (!runtime || !simulationPerfEnabled()) return;
  const details = stateDetails(readState(runtime.callbacks));
  runtime.sampleBaseline = { capturedAt: perfNow(), elapsedSeconds: details.elapsedSeconds };
  const interval = simulationPerfState().sampleIntervalMs;
  runtime.timer = globalThis.setInterval?.(sampleSimulationThroughput, interval) ?? null;
  runtime.timer?.unref?.();
}

function updateOptions(options = {}) {
  const state = simulationPerfState();
  if (typeof options.quiet === 'boolean') state.quiet = options.quiet;
  if (finiteNumber(options.slowMs) != null) state.slowMs = clampOption(options.slowMs, state.slowMs);
  if (finiteNumber(options.sampleIntervalMs) != null) {
    state.sampleIntervalMs = clampOption(options.sampleIntervalMs, state.sampleIntervalMs, 100);
  }
}

function stageReport(stats) {
  return {
    count: stats.count,
    totalMs: rounded(stats.totalMs),
    averageMs: rounded(stats.count ? stats.totalMs / stats.count : 0),
    p50Ms: rounded(percentile(stats.samples ?? [], 0.5)),
    p95Ms: rounded(percentile(stats.samples ?? [], 0.95)),
    p99Ms: rounded(percentile(stats.samples ?? [], 0.99)),
    maxMs: rounded(stats.maxMs),
    lastMs: rounded(stats.lastMs),
    slowCount: stats.slowCount,
  };
}

function throughputReport(samples) {
  const valid = samples.filter((sample) => !sample.clockReset && sample.gameSeconds >= 0);
  const running = valid.filter((sample) => !sample.paused);
  const speeds = running.map((sample) => sample.gameSecondsPerWallSecond).filter(Number.isFinite);
  const totalWallSeconds = running.reduce((sum, sample) => sum + sample.wallMilliseconds / 1_000, 0);
  const totalGameSeconds = running.reduce((sum, sample) => sum + sample.gameSeconds, 0);
  const schedulerDelays = valid.map((sample) => sample.schedulerDelayMs).filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    runningSamples: running.length,
    pausedSamples: valid.filter((sample) => sample.paused).length,
    clockResets: samples.filter((sample) => sample.clockReset).length,
    stalledRunningSamples: running.filter((sample) => sample.gameSeconds <= 0).length,
    totalWallSeconds: rounded(totalWallSeconds),
    totalGameSeconds: rounded(totalGameSeconds),
    averageGameSecondsPerWallSecond: rounded(totalWallSeconds > 0 ? totalGameSeconds / totalWallSeconds : 0),
    p50GameSecondsPerWallSecond: rounded(percentile(speeds, 0.5)),
    p95GameSecondsPerWallSecond: rounded(percentile(speeds, 0.95)),
    maxGameSecondsPerWallSecond: rounded(speeds.length ? Math.max(...speeds) : 0),
    p95SchedulerDelayMs: rounded(percentile(schedulerDelays, 0.95)),
    maxSchedulerDelayMs: rounded(schedulerDelays.length ? Math.max(...schedulerDelays) : 0),
  };
}

function simulationPerfReport() {
  const state = simulationPerfState();
  const stages = Object.fromEntries(Object.entries(state.stages)
    .sort(([, left], [, right]) => right.totalMs - left.totalMs)
    .map(([stage, stats]) => [stage, stageReport(stats)]));
  const ticks = state.ticks.slice(-200).map((tick) => ({
    ...tick,
    durationMs: rounded(tick.durationMs),
    gameSecondsPerComputeSecond: tick.gameSecondsPerComputeSecond == null
      ? null
      : rounded(tick.gameSecondsPerComputeSecond),
  }));
  const samples = state.throughputSamples.slice(-240).map((sample) => ({
    ...sample,
    wallMilliseconds: rounded(sample.wallMilliseconds),
    gameSecondsPerWallSecond: sample.gameSecondsPerWallSecond == null
      ? null
      : rounded(sample.gameSecondsPerWallSecond),
    schedulerDelayMs: rounded(sample.schedulerDelayMs),
  }));
  return {
    version: state.version,
    enabled: simulationPerfEnabled(),
    quiet: state.quiet,
    slowMs: state.slowMs,
    sampleIntervalMs: state.sampleIntervalMs,
    probes: [...state.probes],
    stages,
    throughput: throughputReport(state.throughputSamples),
    ticks,
    samples,
    slowEvents: state.slowEvents.slice(-240).map((event) => ({ ...event })),
  };
}

function installDebugApi() {
  globalThis.__enableOpenWorldSimulationPerfDebug = (configuration = true) => {
    const enabled = configuration !== false;
    const options = configuration && typeof configuration === 'object' ? configuration : {};
    if (options.reset === true || !globalThis[SIMULATION_PERF_STATE]) {
      globalThis[SIMULATION_PERF_STATE] = newSimulationPerfState(options);
    } else {
      updateOptions(options);
    }
    globalThis[SIMULATION_PERF_FLAG] = enabled;
    const runtime = simulationPerfRuntime();
    const probes = enabled
      ? installProbes(runtime)
      : {
          installed: [],
          reused: [],
          unavailable: [],
          ...prepareSimulationPerformanceDiagnostics(runtime?.callbacks),
        };
    if (enabled) startSampler(runtime);
    const state = simulationPerfState();
    const status = {
      enabled,
      quiet: state.quiet,
      slowMs: state.slowMs,
      sampleIntervalMs: state.sampleIntervalMs,
      probes,
    };
    console.info(SIMULATION_PERF_PREFIX, 'toggle', status);
    return status;
  };
  globalThis.__printOpenWorldSimulationPerfDiagnostic = () => {
    const runtime = simulationPerfRuntime();
    if (simulationPerfEnabled()) installProbes(runtime);
    const report = simulationPerfReport();
    console.info(SIMULATION_PERF_PREFIX, 'diagnostic', report);
    return report;
  };
  globalThis.__clearOpenWorldSimulationPerfDiagnostic = () => {
    const previous = simulationPerfState();
    globalThis[SIMULATION_PERF_STATE] = newSimulationPerfState(previous);
    simulationPerfState().probes = [...(simulationPerfRuntime()?.probes ?? [])];
    if (simulationPerfEnabled()) startSampler(simulationPerfRuntime());
    return true;
  };
}

export function installSimulationPerformanceDiagnostics(callbacks) {
  const runtime = globalThis[SIMULATION_PERF_RUNTIME] = {
    version: SIMULATION_PERF_VERSION,
    callbacks,
    probes: [],
    timer: null,
    sampleBaseline: null,
    activeTickId: null,
  };
  installDebugApi();
  const probes = simulationPerfEnabled()
    ? installProbes(runtime)
    : { installed: [], reused: [], unavailable: [] };
  if (simulationPerfEnabled()) startSampler(runtime);
  return { version: SIMULATION_PERF_VERSION, probes };
}

export { SIMULATION_PERF_VERSION };
