(() => {
  const state = window.__subwayBuilder_storeCallbacks__?.getState?.();
  if (!state) throw new Error('Game state is unavailable');
  const perf = window.__openWorldSimulationPerfStateV1__;
  const ticks = (perf?.ticks ?? []).filter(t => Number.isFinite(t.durationMs));
  const durations = ticks.map(t => t.durationMs).sort((a, b) => a - b);
  const percentile = p => durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null;
  const elapsed = state.timeConfig.elapsedSeconds;
  const diag = window.__japanDiagnostics__;
  return {
    capturedAt: Date.now(),
    cityCode: state.cityCode,
    time: state.timeConfig,
    stations: state.stations.length,
    routes: state.routes.length,
    tracks: state.tracks.length,
    trains: state.trains.length,
    movingTrains: state.trains.filter(t => t.motion?.speed > 0).length,
    trainsWithoutMovementForTenMinutes: state.trains.filter(t => Number.isFinite(t.stuckDetection?.lastMovementTime) && elapsed - t.stuckDetection.lastMovementTime > 600).length,
    totalLifetimeRidership: state.totalLifetimeRidership,
    recentRidership: window.SubwayBuilderAPI.gameState.getRidershipStats(),
    modeChoice: window.SubwayBuilderAPI.gameState.getModeChoiceStats(),
    money: state.money,
    heap: performance.memory ? {
      usedBytes: performance.memory.usedJSHeapSize,
      totalBytes: performance.memory.totalJSHeapSize,
    } : null,
    tickWindow: {
      samples: durations.length,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: durations.at(-1) ?? null,
      firstAt: ticks[0]?.capturedAt,
      lastAt: ticks.at(-1)?.capturedAt,
      firstGameSeconds: ticks[0]?.elapsedSeconds,
      lastGameSeconds: ticks.at(-1)?.elapsedSeconds,
    },
    mod: {
      generation: diag?.generation,
      loadStage: diag?.latestAuthoritativeLoad?.segment,
      crossModeShare: diag?.latestCrossModeShare,
      transitionCount: diag?.transitions?.length,
      startup: diag?.startupRuntime,
    },
  };
})()
