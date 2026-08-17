(() => {
  const state = window.__subwayBuilder_storeCallbacks__?.getState?.();
  const summarizeCollection = (value) => ({
    type: value?.constructor?.name ?? typeof value,
    size: value?.size ?? value?.length ?? (value && typeof value === 'object' ? Object.keys(value).length : null),
  });
  const entries = (value) => value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return {
    hasState: Boolean(state),
    cityCode: window.SubwayBuilderAPI?.utils?.getCityCode?.(),
    saveName: window.SubwayBuilderAPI?.gameState?.getSaveName?.(),
    sessionId: window.SubwayBuilderAPI?.gameState?.getGameSessionId?.(),
    paused: window.SubwayBuilderAPI?.gameState?.isPaused?.(),
    stateKeys: state ? Object.keys(state).sort() : [],
    collections: state ? Object.fromEntries(['routes','tracks','stations','trains','stNodes','trackGroups','fareGroups'].map((key) => [key, summarizeCollection(state[key])])) : {},
    routes: entries(state?.routes).map((route) => ({ id: route.id, bullet: route.bullet, fullName: route.fullName, stNodeCount: route.stNodes?.length ?? null, trainCount: route.trainsInRoute?.length ?? null })),
  };
})()
