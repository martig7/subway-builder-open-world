/** Minimal supported native host for behavioral tests; scenarios supply their own data. */
export function createSubwayBuilderHostState(initial = {}) {
  const state = {
    gameMode: 'easy', portolanDiagram: null, portolanProgress: null,
    trackEditSession: null, completedCommutes: [],
    stations: [], stNodes: [], routes: [], trains: [], tracks: [], trackGroups: [],
    signals: [], stationGroups: [], fareGroups: [], mapViewport: {},
    demandData: { points: new Map(), popsMap: new Map() },
    timeConfig: { elapsedSeconds: 0, paused: true },
    setCityCode(value) { state.cityCode = value; },
    setGameMode(value) { state.gameMode = value; },
    setTimeConfig(patch) { state.timeConfig = { ...state.timeConfig, ...patch }; },
    setRoutes(value) { state.routes = value; },
    setTracks({ newTracks = state.tracks, newTrackGroups = state.trackGroups } = {}) {
      state.tracks = newTracks; state.trackGroups = newTrackGroups;
    },
    recalculateAllRouteGeojsons: async () => {},
    setPreviewRoute(value) { state.previewRoute = value; },
    batchPreviewRouteUpdates: async () => {},
    confirmRouteChange() {},
    handleIncrementGameState: async () => {},
    simulateCommutes: async () => {},
    calculatePaths: async () => {},
    loadInitialData() {},
    setFinancialHistory(value) { state.financialHistory = value; },
    setRouteFinancials(value) { state.routeFinancials = value; },
    addRevenue(amount) {
      state.money += amount;
      state.financialHistory.currentHourRevenue += amount;
    },
    addExpense(amount) {
      state.money -= amount;
      state.financialHistory.currentHourExpenses += amount;
    },
    recordRouteFinancials() {},
    setCompletedCommutes(value) { state.completedCommutes = value; },
    ...initial,
  };
  return state;
}
