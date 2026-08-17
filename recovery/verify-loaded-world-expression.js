(() => {
  const api = window.SubwayBuilderAPI;
  const state = window.__subwayBuilder_storeCallbacks__?.getState?.();
  const diagnostics = window.__nyStatePilotDiagnostics__;
  const routes = api?.gameState?.getRoutes?.() ?? state?.routes ?? [];
  const routeList = Array.isArray(routes) ? routes : Object.values(routes ?? {});
  const tracks = api?.gameState?.getTracks?.() ?? state?.tracks ?? [];
  const trackList = Array.isArray(tracks) ? tracks : Object.values(tracks ?? {});
  const trains = api?.gameState?.getTrains?.() ?? state?.trains ?? [];
  const trainList = Array.isArray(trains) ? trains : Object.values(trains ?? {});
  return {
    href: location.href,
    cityCode: api?.utils?.getCityCode?.(),
    saveName: api?.gameState?.getSaveName?.(),
    gameSessionId: api?.gameState?.getGameSessionId?.(),
    paused: api?.gameState?.isPaused?.(),
    routeCount: routeList.length,
    routes: routeList.map((route) => ({
      id: route?.id,
      bullet: route?.bullet,
      name: route?.fullName ?? route?.name,
      stops: route?.stNodes?.length ?? route?.stations?.length ?? null,
    })),
    trackCount: trackList.length,
    trainCount: trainList.length,
    latest: diagnostics?.latest ?? null,
    startup: diagnostics?.startup ?? null,
    authoritativeLoad: diagnostics?.latestAuthoritativeLoad ?? null,
  };
})()
