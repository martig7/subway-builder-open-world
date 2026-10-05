import { sharedNativeDemandEvaluator } from './embedded-tile-package-adapter.js';
import { deterministicNetworkProfile } from './off-tile-native-demand.js';

export const ACTIVE_DEMAND_PREPARATION_VERSION = 'active-demand-preparation-v5';
const values = value => value instanceof Map ? value.values() : value ?? [];

export function createActiveDemandPreparation({ game, getState, workerSource, evaluator = sharedNativeDemandEvaluator(workerSource),
  admit = async () => {}, getDemandRevisionKey = () => null }) {
  const stats = { preparations: 0, loads: 0, hits: 0, calculations: 0, cacheBytes: 0, lastStatus: null, lastError: null };
  const evaluate = async ({ assignments = false, tileId = getState().cityCode } = {}) => {
    await admit();
    const state = getState();
    if (state.cityCode !== tileId || !state.demandData?.popsMap) return null;
    const demandData = state.demandData;
    const demandRevisionKey = getDemandRevisionKey(tileId);
    const networkProfile = deterministicNetworkProfile(game.captureCrossTileNetworkProfile(tileId));
    // The raw signature includes moving train anchors that this evaluator
    // deliberately replaces with configured service. Do not key on that clock.
    delete networkProfile.signature;
    const input = { worldId: state.gameSessionId, tileId, includeAssignments: true,
      networkProfile,
      farePolicy: { fare: state.transitCost, fareGroups: state.fareGroups }, globalNativeState: state, demandRevisionKey };
    // Construct only compact scalar input after the shared worker admits the
    // job. Never stringify native commutes, mode-share maps or building data.
    const bytes = () => new TextEncoder().encode(JSON.stringify({
      points: Array.from(values(demandData.points), ({ id, location, residents, jobs }) => ({ id, location, residents, jobs })),
      pops: Array.from(values(demandData.popsMap), ({ id, size, residenceId, jobId, drivingSeconds, drivingDistance,
        homeDepartureTime, workDepartureTime }) => ({ id, size, residenceId, jobId, drivingSeconds, drivingDistance,
        homeDepartureTime, workDepartureTime })),
    }));
    const result = await evaluator.evaluate(bytes, input, { cacheMode: assignments ? 'assignments' : 'prepare' });
    // A native edit can begin while the worker is running; its revision is not
    // published until durability. Wait for that edit before accepting the result.
    await admit();
    if (getState().gameSessionId !== state.gameSessionId || getState().cityCode !== tileId
      || getDemandRevisionKey(tileId) !== demandRevisionKey) throw new Error('Native demand preparation was superseded');
    if (!result) throw new Error('The native demand worker is unavailable; reload the mod before preparing demand.');
    stats[assignments ? 'loads' : 'preparations']++;
    stats[result.diskCache === 'hit' ? 'hits' : 'calculations']++;
    stats.cacheBytes = result.cacheBytes ?? 0; stats.lastStatus = result.diskCache; stats.lastError = result.cacheError ?? null;
    // An active profile uses the loaded departures/full native network. Mark it
    // separately so switching away requires the inactive tile estimator again.
    return { ...result, profile: { ...result.profile, source: 'active-tile-prepared', demandRevisionKey } };
  };
  return { prepare: evaluate, releaseIdle: () => evaluator.releaseIdle?.(),
    snapshot: () => ({ version: ACTIVE_DEMAND_PREPARATION_VERSION, ...stats, worker: evaluator.snapshot() }),
  };
}
