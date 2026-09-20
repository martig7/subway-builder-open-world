import { SHARED_TRANSIT_STATE_KEYS, hasCompleteNativeTopology } from './shared-transit-network.js';
import { stripNetworkFromSnapshot } from './network-projection.js';

export const NATIVE_HANDOFF_VERIFICATION_VERSION = 'native-handoff-exact-reuse-v4';
export const NATIVE_HANDOFF_LOAD_WAIT_VERSION = 'native-handoff-load-wait-v1';
const OWNER = Symbol.for('open-world.native-handoff-load-observer');
const RECOVERY_METADATA_KEY = 'openWorldNativeRecovery';
const LEDGER_KEYS = [
  'gameMode', 'money', 'transitCost', 'financialHistory', 'bonds', 'completedCommutes',
  'playTimeSeconds', 'totalLifetimeRidership', 'dailyStats', 'stationsDemolishedAllTime',
  'buildingDemolitionSpendAllTime', 'everDemolishedBuilding', 'demolishedOsmIds',
  'routesDeletedAllTime', 'firstTransferMadeAt', 'hasGoneBankrupt', 'rockefellerPaidOut',
  'yardsEnabled', 'yards', 'trackEditSession',
];

const PAIR_CACHE_LIMIT = 8_192;
const EMPTY_NATIVE_YARDS = Object.freeze([]);
const RESET_SIGNAL_STATUS = Object.freeze({ occupations: Object.freeze([]), reservedBy: null });

// Keep one bounded path stack and render it only for a mismatch. Building a
// new path string and two Object.keys arrays at every matching node caused
// allocation pressure while checking a large network near the renderer limit.
function mismatchPath(path, suffix = '') {
  let result = String(path[0]);
  for (let index = 1; index < path.length; index++) {
    result += typeof path[index] === 'number' ? `[${path[index]}]` : `.${path[index]}`;
  }
  return result + suffix;
}

function ownKeyCount(value) {
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) count++;
  return count;
}

function rememberPair(left, right, budget) {
  if (budget.pairs.has(left)) { budget.pairs.set(left, right); return; }
  if (budget.order.length < PAIR_CACHE_LIMIT) budget.order.push(left);
  else {
    budget.pairs.delete(budget.order[budget.nextPair]);
    budget.order[budget.nextPair] = left;
    budget.nextPair = (budget.nextPair + 1) % PAIR_CACHE_LIMIT;
  }
  budget.pairs.set(left, right);
}

// Compare nested values, not IDs/counts or lossy hashes. Only completely
// compared object pairs enter the capped cache, so a cycle cannot validate
// itself. One pair per left object bounds auxiliary memory even when native
// reconstruction produces many distinct right-hand objects for a shared node.
function difference(left, right, path, budget, depth = 0, resetSignalStatus = false) {
  if (--budget.remaining < 0 || depth > 128) return mismatchPath(path, ':comparison-limit');
  if (Object.is(left, right)) return null;
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return mismatchPath(path);
  if (Array.isArray(left) !== Array.isArray(right)) return mismatchPath(path);
  if (!resetSignalStatus && budget.pairs.get(left) === right) return null;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return mismatchPath(path, '.length');
    for (let i = 0; i < left.length; i++) {
      path.push(i);
      const mismatch = difference(left[i], right[i], path, budget, depth + 1);
      path.pop();
      if (mismatch) return mismatch;
    }
  } else {
    if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return mismatchPath(path);
    if (ownKeyCount(left) !== ownKeyCount(right)) return mismatchPath(path, ':keys');
    for (const key in left) {
      if (!Object.hasOwn(left, key)) continue;
      path.push(key);
      if (!Object.hasOwn(right, key)) return mismatchPath(path, ':missing');
      const mismatch = resetSignalStatus && key === 'status' ? null
        : difference(left[key], right[key], path, budget, depth + 1);
      path.pop();
      if (mismatch) return mismatch;
    }
  }
  if (!resetSignalStatus) rememberPair(left, right, budget);
  return null;
}

export function nativeHandoffEvidence(snapshot, marker) {
  if (marker?.reason !== 'tile-navigation' || !marker.transitionId || !marker.recoveryId
    || !snapshot?.id || !snapshot.gameSessionId || !hasCompleteNativeTopology(snapshot.data)
    || !Number.isFinite(snapshot.data?.timeConfig?.elapsedSeconds)
    || !Number.isFinite(snapshot.data?.money)) return null;
  return Object.freeze({ version: NATIVE_HANDOFF_VERIFICATION_VERSION,
    recoveryId: marker.recoveryId, transitionId: marker.transitionId,
    sourceCityCode: marker.sourceCityCode, destinationCityCode: marker.destinationCityCode,
    nativeSessionId: snapshot.gameSessionId, snapshotId: snapshot.id });
}

// The tile bookmark retains local save fields, but never clones the complete
// topology merely to empty it again. Only this small shell crosses clone().
export function stripVerifiedNativeHandoffNetwork(snapshot) {
  return stripNetworkFromSnapshot(snapshot);
}

function compareSignals(expected, actual, budget) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return 'signals.length';
  const path = ['signals', 0];
  for (let i = 0; i < expected.length; i++) {
    path[1] = i;
    const saved = expected[i], loaded = actual[i];
    // Native 1.7.0 loadSave regenerates v-merge signals from tracks, resetting
    // their occupancy. All topology and unknown fields must still agree.
    if (saved?.type === 'v-merge' && loaded?.type === 'v-merge'
      && saved.status && ownKeyCount(saved.status) === 2
      && Object.hasOwn(saved.status, 'occupations') && Object.hasOwn(saved.status, 'reservedBy')) {
      path.push('status');
      const statusMismatch = difference(RESET_SIGNAL_STATUS, loaded.status, path, budget);
      path.pop();
      if (statusMismatch) return statusMismatch;
      const mismatch = difference(saved, loaded, path, budget, 0, true);
      if (mismatch) return mismatch;
    } else {
      const mismatch = difference(saved, loaded, path, budget);
      if (mismatch) return mismatch;
    }
  }
  return null;
}

function compareState(expected, actual, { networkOnly = false, nativeLoad = false } = {}) {
  const budget = { remaining: 32_000_000, pairs: new Map(), order: [], nextPair: 0 };
  const path = [''];
  for (const key of networkOnly ? SHARED_TRANSIT_STATE_KEYS : [...SHARED_TRANSIT_STATE_KEYS, ...LEDGER_KEYS]) {
    if (!Object.hasOwn(expected, key)) continue;
    path[0] = key;
    // Native 1.7 generateSave emits undefined for disabled yards, and loadSave
    // applies exactly these nullish defaults. Only normalize the live result;
    // the actual incoming payload must still match the staged source values.
    let expectedValue = expected[key];
    if (nativeLoad && expectedValue == null) {
      if (key === 'yardsEnabled') expectedValue = false;
      else if (key === 'yards') expectedValue = EMPTY_NATIVE_YARDS;
      // loadSave also uses null for no edit session. A synthesized recovery
      // session for disrupted routes remains a non-null mismatch and falls back.
      else if (key === 'trackEditSession') expectedValue = null;
    }
    const mismatch = nativeLoad && key === 'signals'
      ? compareSignals(expected[key], actual?.[key], budget)
      : difference(expectedValue, actual?.[key], path, budget);
    if (mismatch) return mismatch;
  }
  if (!networkOnly) {
    const expectedTime = expected.timeConfig, actualTime = actual?.timeConfig;
    path[0] = 'timeConfig';
    for (const key in expectedTime ?? {}) {
      if (!Object.hasOwn(expectedTime, key)) continue;
      if (key === 'paused') continue; // Both native load and transition deliberately pause.
      path.push(key);
      const mismatch = difference(expectedTime[key], actualTime?.[key], path, budget);
      path.pop();
      if (mismatch) return mismatch;
    }
  }
  return null;
}

/** One in-memory observer, armed only after a tile handoff was staged. Neither
 * evidence nor snapshots are persisted. Unrelated loads invalidate the proof.
 * Successful consumption requires both the loader payload and live native
 * state to match the staged authority; uncertainties take the normal restore.
 */
export function observeNativeTileHandoff({ getState, evidence, snapshot }) {
  const state = getState();
  state.loadSave?.[OWNER]?.dispose();
  let expected = snapshot, proof = evidence, observed = false, invalid = null, disposed = false, loading = 0;
  const listeners = new Set();
  const identity = { transitionId: evidence?.transitionId ?? null, recoveryId: evidence?.recoveryId ?? null };
  const original = state.loadSave;
  const fail = reason => ({ reused: false, reason, version: NATIVE_HANDOFF_VERIFICATION_VERSION });
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const controller = {
    status() {
      return { ...identity, state: disposed ? 'consumed' : invalid ? 'invalid'
        : loading ? 'loading-exact' : observed ? 'observed' : 'armed', reason: invalid };
    },
    waitForLoad({ isCurrent = () => true, timeoutMs = 180_000 } = {}) {
      // Native 1.7 emits onCityLoad inside loadInitialData, then retrieves and
      // applies the pending save. The hook ignores returned promises, so this
      // wait yields to that first native load instead of starting a second one.
      // Poll only the compact ownership predicate; payload verification remains
      // in the loader wrapper and consume() still verifies the live state.
      const duration = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 300_000)) : 180_000;
      return new Promise(resolve => {
        let timer = null, finished = false;
        const deadline = Date.now() + duration;
        const finish = value => {
          if (finished) return;
          finished = true;
          if (timer != null) clearTimeout(timer);
          listeners.delete(check);
          resolve({ ...value, waitVersion: NATIVE_HANDOFF_LOAD_WAIT_VERSION });
        };
        const check = () => {
          if (finished) return;
          if (timer != null) { clearTimeout(timer); timer = null; }
          let current = false;
          try { current = isCurrent(); } catch {}
          if (!current) {
            finish({ ...identity, state: 'cancelled', reason: 'handoff-context-expired' });
            controller.dispose();
            return;
          }
          const value = controller.status();
          if (disposed || (!loading && (observed || invalid))) { finish(value); return; }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            finish({ ...identity, state: 'timeout', reason: 'staged-native-load-timeout' });
            return;
          }
          timer = setTimeout(check, Math.min(50, remaining));
        };
        listeners.add(check);
        check();
      });
    },
    consume({ transitionId, destinationCityCode, sourceCityCode, snapshot: staged, nativeNetwork }) {
      if (disposed) return fail('handoff-observer-disposed');
      try {
        if (invalid) return fail(invalid);
        if (!observed) return fail('staged-native-load-not-observed');
        if (transitionId !== proof.transitionId || destinationCityCode !== proof.destinationCityCode
          || sourceCityCode !== proof.sourceCityCode || staged !== expected) return fail('handoff-context-mismatch');
        const live = getState();
        if (live.gameSessionId !== proof.nativeSessionId || live.cityCode !== destinationCityCode) return fail('native-identity-mismatch');
        const canonicalMismatch = nativeNetwork && compareState(expected.data, nativeNetwork, { networkOnly: true });
        if (canonicalMismatch) return fail(`canonical-mismatch:${canonicalMismatch}`);
        const mismatch = compareState(expected.data, live, { nativeLoad: true });
        if (mismatch) return fail(`native-state-mismatch:${mismatch}`);
        // Subway Builder 1.7 omits this store-only cursor when loading a save.
        // Restore just that unpaid interval after all ledger/network checks.
        if (Number.isFinite(expected.data.lastInfrastructureChargeTime)) {
          live.lastInfrastructureChargeTime = expected.data.lastInfrastructureChargeTime;
        }
        return { reused: true, reason: 'verified-staged-native-load', version: NATIVE_HANDOFF_VERIFICATION_VERSION,
          recoveryId: proof.recoveryId, transitionId: proof.transitionId, nativeSessionId: proof.nativeSessionId };
      } catch {
        return fail('handoff-verification-failed');
      } finally { controller.dispose(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      expected = null; proof = null;
      try {
        const live = getState();
        if (live.loadSave === wrapper) live.loadSave = original;
      } catch { /* A replaced/read-only store must not prevent normal fallback. */ }
      notify();
      listeners.clear();
    },
  };
  function wrapper(save, ...args) {
    if (disposed) return original.call(this, save, ...args);
    let matches = false;
    try {
      const marker = save?.metadata?.[RECOVERY_METADATA_KEY];
      matches = marker?.schemaVersion === 1 && marker.reason === 'tile-navigation'
        && marker.recoveryId === proof.recoveryId && marker.transitionId === proof.transitionId
        && marker.sourceCityCode === proof.sourceCityCode && marker.destinationCityCode === proof.destinationCityCode
        && save.id === proof.snapshotId && save.gameSessionId === proof.nativeSessionId
        && save.cityCode === proof.destinationCityCode;
      if (!matches || observed) invalid = 'unexpected-native-save-load';
      else {
        const mismatch = compareState(expected.data, save.data);
        if (mismatch) invalid = `loader-payload-mismatch:${mismatch}`;
      }
    } catch { invalid = 'loader-payload-verification-failed'; }
    // Even an invalid payload still enters the native loader. Expose its
    // invalid identity immediately for manual-load cancellation, but do not
    // let conservative restore overlap any asynchronous native invocation.
    loading++;
    notify();
    const complete = value => {
      loading--;
      if (!disposed && !invalid && matches) observed = true;
      notify();
      return value;
    };
    const failed = error => {
      loading--; invalid = 'native-save-load-failed'; notify(); throw error;
    };
    try {
      const result = original.call(this, save, ...args);
      return result && typeof result.then === 'function'
        ? result.then(complete, failed)
        : complete(result);
    } catch (error) { return failed(error); }
  }
  Object.defineProperty(wrapper, OWNER, { value: controller });
  if (typeof original !== 'function' || evidence?.version !== NATIVE_HANDOFF_VERIFICATION_VERSION
    || !snapshot?.data || !hasCompleteNativeTopology(snapshot.data)) invalid = 'unsupported-native-handoff';
  else {
    try { state.loadSave = wrapper; if (state.loadSave !== wrapper) invalid = 'native-load-observer-unavailable'; }
    catch { invalid = 'native-load-observer-unavailable'; }
  }
  return controller;
}
