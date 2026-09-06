const RECOVERY_METADATA_KEY = 'openWorldNativeRecovery';
const RELOAD_GUARD_KEY = '__openWorldNativeReloadRecoveryGuard__';
const ORIGINAL_RELOAD_KEY = '__openWorldNativeReloadRecoveryOriginal__';
const RELOAD_GUARD_VERSION_KEY = '__openWorldNativeReloadRecoveryVersion__';

export const NATIVE_RELOAD_RECOVERY_VERSION = 5;
export const NATIVE_RECOVERY_CHECKPOINT_INTERVAL_MS = 15_000;

function nativeSaveData(snapshot) {
  return snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
}

function assertNativeSave(snapshot) {
  const data = nativeSaveData(snapshot);
  for (const key of ['routes', 'tracks', 'trains']) {
    if (!Array.isArray(data?.[key])) {
      throw new Error(`Native recovery snapshot is missing ${key}`);
    }
  }
}

function recoveryMarker(save) {
  const marker = save?.metadata?.[RECOVERY_METADATA_KEY];
  return marker?.schemaVersion === 1 && typeof marker.recoveryId === 'string'
    ? marker
    : null;
}

function pendingSaveFrom(result) {
  return result?.save ?? result?.data ?? null;
}

async function readPendingSave(electron) {
  if (typeof electron?.getPendingSave !== 'function') return null;
  try {
    const result = await electron.getPendingSave();
    if (result?.success === false) return null;
    return pendingSaveFrom(result);
  } catch {
    return null;
  }
}

function currentGameRoute(location) {
  const hashPath = typeof location?.hash === 'string'
    ? location.hash.replace(/^#/, '').split('?')[0]
    : '';
  return hashPath === '/game' || location?.pathname === '/game';
}

function unwrapNativeReload(reload) {
  let current = reload;
  const seen = new Set();
  while (typeof current?.[ORIGINAL_RELOAD_KEY] === 'function' && !seen.has(current)) {
    seen.add(current);
    current = current[ORIGINAL_RELOAD_KEY];
  }
  return current;
}

function tryReplaceNativeReload(electron, expected, replacement) {
  try {
    if (electron.reloadWindow !== expected) return false;
    electron.reloadWindow = replacement;
    return electron.reloadWindow === replacement;
  } catch {
    return false;
  }
}

/**
 * Stage an ephemeral Native Save in Subway Builder's main process. The save is
 * the sole recovery authority; no rail or finance data is written to sidecar
 * storage.
 */
export async function stageNativeRecovery({
  electron,
  snapshot,
  destinationCityCode,
  sourceCityCode = snapshot?.cityCode ?? null,
  reason = 'renderer-reload',
  transitionId = null,
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto?.randomUUID?.()
    ?? `recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
} = {}) {
  if (typeof electron?.setPendingSave !== 'function') {
    throw new Error('Native pending-save recovery is unavailable in this game build');
  }
  if (typeof destinationCityCode !== 'string' || !destinationCityCode) {
    throw new Error('Native recovery requires a destination city code');
  }
  assertNativeSave(snapshot);
  const recoveryId = randomUUID();
  const handoff = structuredClone(snapshot);
  handoff.cityCode = destinationCityCode;
  handoff.cityUid = destinationCityCode;
  if (handoff.data && Object.hasOwn(handoff.data, 'cityCode')) {
    handoff.data.cityCode = destinationCityCode;
  }
  if (handoff.data && Object.hasOwn(handoff.data, 'cityUid')) {
    handoff.data.cityUid = destinationCityCode;
  }
  handoff.metadata = {
    ...(handoff.metadata ?? {}),
    [RECOVERY_METADATA_KEY]: {
      schemaVersion: 1,
      recoveryId,
      reason,
      transitionId,
      sourceCityCode,
      destinationCityCode,
      stagedAt: now(),
    },
  };
  const result = await electron.setPendingSave(handoff);
  if (result?.success === false) {
    throw new Error(result.error ?? 'Could not stage the native recovery save');
  }

  return {
    status: 'staged',
    recoveryId,
    reason,
    sourceCityCode,
    destinationCityCode,
    async rollback() {
      if (typeof electron.clearPendingSave !== 'function') return false;
      const pending = await readPendingSave(electron);
      if (recoveryMarker(pending)?.recoveryId !== recoveryId) return false;
      await electron.clearPendingSave();
      return true;
    },
  };
}

/**
 * Delay the base game's renderer reload until a Native Save handoff exists.
 * The CrashBoundary does not await reloadWindow(), so the wrapper owns the
 * asynchronous staging and calls the original native reload afterward.
 */
export function installNativeReloadRecoveryGuard({
  globalObject = globalThis,
  electron = globalThis.window?.electron ?? globalThis.electron,
  location = globalThis.location,
  captureSnapshot,
  getCityCode,
  logger = console,
  checkpointIntervalMs = NATIVE_RECOVERY_CHECKPOINT_INTERVAL_MS,
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
} = {}) {
  if (typeof electron?.reloadWindow !== 'function'
    || typeof captureSnapshot !== 'function'
    || typeof getCityCode !== 'function') {
    return { installed: false, dispose() {}, flush: async () => {} };
  }

  globalObject[RELOAD_GUARD_KEY]?.dispose?.();
  const nativeReload = unwrapNativeReload(electron.reloadWindow);
  let disposed = false;
  let bypassDepth = 0;
  let pendingRecovery = null;
  let checkpointTimer = null;
  let snapshotTemplate = null;
  let routeGeneration = 0;

  const prepareRecovery = async () => {
    const generation = routeGeneration;
    const cancelled = () => disposed || bypassDepth > 0
      || generation !== routeGeneration || !currentGameRoute(location);
    if (cancelled()) return { status: 'skipped' };
    const existingPendingSave = await readPendingSave(electron);
    if (cancelled()) return { status: 'skipped' };
    if (existingPendingSave && !recoveryMarker(existingPendingSave)) {
      return { status: 'preserved-explicit-save' };
    }
    const snapshot = await captureSnapshot(
      snapshotTemplate ?? (recoveryMarker(existingPendingSave) ? existingPendingSave : null),
    );
    if (cancelled()) return { status: 'skipped' };
    const cityCode = getCityCode() ?? snapshot?.cityCode;
    const staged = await stageNativeRecovery({
      electron,
      snapshot,
      sourceCityCode: cityCode,
      destinationCityCode: cityCode,
      reason: 'renderer-reload',
    });
    if (cancelled()) {
      await staged.rollback();
      return { status: 'skipped' };
    }
    snapshotTemplate = snapshot;
    return staged;
  };

  const checkpoint = () => {
    if (pendingRecovery) return pendingRecovery;
    pendingRecovery = prepareRecovery()
      .catch((error) => {
        logger.error?.('[OpenWorld] native renderer-reload recovery staging failed', error);
        return { status: 'failed', error };
      })
      .finally(() => { pendingRecovery = null; });
    return pendingRecovery;
  };

  const clearManagedCheckpoint = async () => {
    const pending = await readPendingSave(electron);
    if (!recoveryMarker(pending) || typeof electron.clearPendingSave !== 'function') return false;
    await electron.clearPendingSave();
    return true;
  };

  const guardedReload = (...args) => {
    if (disposed || bypassDepth > 0 || !currentGameRoute(location)) {
      return nativeReload.apply(electron, args);
    }
    if (pendingRecovery) return pendingRecovery;
    pendingRecovery = (async () => {
      try {
        await prepareRecovery();
      } catch (error) {
        logger.error?.('[OpenWorld] native renderer-reload recovery staging failed', error);
      } finally {
        try {
          nativeReload.apply(electron, args);
        } finally {
          pendingRecovery = null;
        }
      }
    })();
    return pendingRecovery;
  };
  Object.defineProperties(guardedReload, {
    [ORIGINAL_RELOAD_KEY]: { value: nativeReload },
    [RELOAD_GUARD_VERSION_KEY]: { value: NATIVE_RELOAD_RECOVERY_VERSION },
  });
  const mode = tryReplaceNativeReload(electron, electron.reloadWindow, guardedReload)
    ? 'wrapper'
    : 'checkpoint';

  const handleRouteChange = () => {
    if (currentGameRoute(location)) {
      return checkpoint();
    } else {
      routeGeneration += 1;
      snapshotTemplate = null;
      return clearManagedCheckpoint().catch((error) => {
        logger.error?.('[OpenWorld] native recovery checkpoint cleanup failed', error);
      });
    }
  };

  const controller = {
    installed: true,
    version: NATIVE_RELOAD_RECOVERY_VERSION,
    mode,
    wrapper: mode === 'wrapper' ? guardedReload : null,
    checkpoint,
    flush: async () => pendingRecovery,
    runWithoutRecovery(action) {
      bypassDepth += 1;
      try {
        const result = action();
        if (result && typeof result.finally === 'function') {
          return result.finally(() => { bypassDepth -= 1; });
        }
        bypassDepth -= 1;
        return result;
      } catch (error) {
        bypassDepth -= 1;
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (checkpointTimer != null && typeof clearIntervalFn === 'function') {
        clearIntervalFn(checkpointTimer);
        checkpointTimer = null;
      }
      globalObject.removeEventListener?.('hashchange', handleRouteChange);
      if (mode === 'wrapper') tryReplaceNativeReload(electron, guardedReload, nativeReload);
      if (globalObject[RELOAD_GUARD_KEY] === controller) delete globalObject[RELOAD_GUARD_KEY];
    },
  };
  globalObject[RELOAD_GUARD_KEY] = controller;
  if (mode === 'checkpoint') {
    void checkpoint();
    if (Number.isFinite(checkpointIntervalMs)
      && checkpointIntervalMs > 0
      && typeof setIntervalFn === 'function') {
      checkpointTimer = setIntervalFn(() => { void checkpoint(); }, checkpointIntervalMs);
      checkpointTimer?.unref?.();
    }
    globalObject.addEventListener?.('hashchange', handleRouteChange);
  }
  return controller;
}

export {
  RECOVERY_METADATA_KEY,
  RELOAD_GUARD_KEY,
  ORIGINAL_RELOAD_KEY,
  RELOAD_GUARD_VERSION_KEY,
};
