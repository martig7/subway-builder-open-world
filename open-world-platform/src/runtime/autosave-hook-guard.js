function normalizedSaveName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const OPEN_WORLD_RUNTIME_SAVE_NAME = 'open-world-runtime';
export const LEGACY_OPEN_WORLD_RUNTIME_SAVE_NAMES = Object.freeze(['kc-two-tile-runtime']);
export const OPEN_WORLD_RUNTIME_METADATA_KEY = 'openWorldRuntimeSnapshot';

/** Stamp synthetic native saves with durable provenance and a generic name. */
export function stampOpenWorldRuntimeSnapshot(snapshot, { purpose = 'tile-runtime' } = {}) {
  return {
    ...snapshot,
    name: OPEN_WORLD_RUNTIME_SAVE_NAME,
    metadata: {
      ...(snapshot?.metadata ?? {}),
      [OPEN_WORLD_RUNTIME_METADATA_KEY]: {
        schemaVersion: 1,
        purpose,
      },
    },
  };
}

/** Read current metadata and legacy names during the snapshot migration. */
export function openWorldRuntimeSnapshotProvenance(snapshot) {
  const marker = snapshot?.metadata?.[OPEN_WORLD_RUNTIME_METADATA_KEY];
  const saveName = normalizedSaveName(snapshot?.name);
  const legacyName = LEGACY_OPEN_WORLD_RUNTIME_SAVE_NAMES.includes(saveName);
  return {
    internal: marker?.schemaVersion === 1
      || saveName === OPEN_WORLD_RUNTIME_SAVE_NAME
      || legacyName,
    marker: marker?.schemaVersion === 1 ? marker : null,
    saveName,
    legacyName,
  };
}

/**
 * Native generateSave fires onGameSaved before it returns its payload. A
 * checkpoint captures a snapshot through generateSave as well, so the hook
 * must not start another checkpoint while the first one is still running.
 *
 * The native hook registry can also replay onGameLoaded after saving, even
 * after the mod script has been evaluated into a new closure. Correlate that
 * replay with the save event in sessionStorage. This is an event token, not a
 * time window: the next matching load callback consumes it.
 */
export function createNativeSaveLifecycle({
  sessionStorage = globalThis.sessionStorage,
  storageKey = 'open-world:pending-native-save-echo',
  internalSaveNames = [OPEN_WORLD_RUNTIME_SAVE_NAME, ...LEGACY_OPEN_WORLD_RUNTIME_SAVE_NAMES],
  trace = null,
} = {}) {
  let activeSaveName = null;
  let activeNativeSessionId = null;
  let activeLoadObserved = false;
  let pendingLoadEcho = null;
  let activeInternalOperation = null;
  let pendingInternalOperation = null;
  let internalOperationSequence = 0;
  const internalStorageKey = `${storageKey}:internal-operation`;
  const normalizedInternalSaveNames = new Set(
    (Array.isArray(internalSaveNames) ? internalSaveNames : [])
      .map(normalizedSaveName)
      .filter(Boolean),
  );

  function emit(event, details = {}) {
    if (typeof trace !== 'function') return;
    try { trace(event, { storageKey, ...details }); } catch {
      // Diagnostic output must never alter lifecycle behavior.
    }
  }

  function readPendingLoadEcho() {
    try {
      if (typeof sessionStorage?.getItem !== 'function') {
        emit('token.read', { source: 'memory', token: pendingLoadEcho, persistenceAvailable: false });
        return pendingLoadEcho;
      }
      const raw = sessionStorage.getItem(storageKey);
      const stored = JSON.parse(raw ?? 'null');
      if (normalizedSaveName(stored?.saveName) == null) {
        emit('token.read', { source: raw == null ? 'empty' : 'invalid', raw, token: pendingLoadEcho });
        return pendingLoadEcho;
      }
      const token = {
        saveName: normalizedSaveName(stored.saveName),
        nativeSessionId: normalizedSaveName(stored.nativeSessionId),
      };
      emit('token.read', { source: 'sessionStorage', raw, token });
      return token;
    } catch (error) {
      emit('token.read-error', { error: error?.message ?? String(error), token: pendingLoadEcho });
      return pendingLoadEcho;
    }
  }

  function writePendingLoadEcho(value) {
    pendingLoadEcho = value;
    try {
      if (value) {
        if (typeof sessionStorage?.setItem !== 'function') {
          emit('token.write', { token: value, persisted: false, reason: 'sessionStorage-unavailable' });
          return;
        }
        const serialized = JSON.stringify(value);
        sessionStorage.setItem(storageKey, serialized);
        emit('token.write', {
          token: value,
          persisted: sessionStorage.getItem?.(storageKey) === serialized,
          storedValue: sessionStorage.getItem?.(storageKey) ?? null,
        });
      } else {
        if (typeof sessionStorage?.removeItem !== 'function') {
          emit('token.clear', { persisted: false, reason: 'sessionStorage-unavailable' });
          return;
        }
        sessionStorage.removeItem(storageKey);
        emit('token.clear', { persisted: sessionStorage.getItem?.(storageKey) == null });
      }
    } catch (error) {
      emit(value ? 'token.write-error' : 'token.clear-error', {
        token: value,
        error: error?.message ?? String(error),
      });
      // The in-memory token still protects the current mod generation.
    }
  }

  function consumePendingLoadEcho() {
    writePendingLoadEcho(null);
  }

  function readPendingInternalOperation() {
    try {
      if (typeof sessionStorage?.getItem !== 'function') {
        emit('internal-operation.read', {
          source: 'memory',
          operation: pendingInternalOperation,
          persistenceAvailable: false,
        });
        return pendingInternalOperation;
      }
      const raw = sessionStorage.getItem(internalStorageKey);
      const stored = JSON.parse(raw ?? 'null');
      if (typeof stored?.operationId !== 'string') {
        emit('internal-operation.read', {
          source: raw == null ? 'empty' : 'invalid',
          raw,
          operation: pendingInternalOperation,
        });
        return pendingInternalOperation;
      }
      const operation = {
        operationId: stored.operationId,
        kind: normalizedSaveName(stored.kind) ?? 'runtime-snapshot',
        saveName: normalizedSaveName(stored.saveName),
        nativeSessionId: normalizedSaveName(stored.nativeSessionId),
        metadataMarked: stored.metadataMarked === true,
      };
      emit('internal-operation.read', { source: 'sessionStorage', raw, operation });
      return operation;
    } catch (error) {
      emit('internal-operation.read-error', {
        error: error?.message ?? String(error),
        operation: pendingInternalOperation,
      });
      return pendingInternalOperation;
    }
  }

  function writePendingInternalOperation(operation) {
    pendingInternalOperation = operation;
    try {
      if (operation) {
        if (typeof sessionStorage?.setItem !== 'function') {
          emit('internal-operation.write', {
            operation,
            persisted: false,
            reason: 'sessionStorage-unavailable',
          });
          return;
        }
        const serialized = JSON.stringify(operation);
        sessionStorage.setItem(internalStorageKey, serialized);
        emit('internal-operation.write', {
          operation,
          persisted: sessionStorage.getItem?.(internalStorageKey) === serialized,
        });
      } else {
        if (typeof sessionStorage?.removeItem !== 'function') {
          emit('internal-operation.clear', {
            persisted: false,
            reason: 'sessionStorage-unavailable',
          });
          return;
        }
        sessionStorage.removeItem(internalStorageKey);
        emit('internal-operation.clear', {
          persisted: sessionStorage.getItem?.(internalStorageKey) == null,
        });
      }
    } catch (error) {
      emit(operation ? 'internal-operation.write-error' : 'internal-operation.clear-error', {
        operation,
        error: error?.message ?? String(error),
      });
    }
  }

  function sameNativeSession(expected, observed) {
    const normalizedExpected = normalizedSaveName(expected);
    const normalizedObserved = normalizedSaveName(observed);
    return normalizedExpected == null
      || normalizedObserved == null
      || normalizedExpected === normalizedObserved;
  }

  function observeInternalLoad(saveName, nativeSessionId = null) {
    const normalized = normalizedSaveName(saveName);
    const normalizedSessionId = normalizedSaveName(nativeSessionId);
    if (activeInternalOperation
      && sameNativeSession(activeInternalOperation.nativeSessionId, normalizedSessionId)) {
      const operation = activeInternalOperation;
      writePendingInternalOperation(null);
      emit('internal-operation.match', {
        matched: true,
        reason: 'active-operation',
        saveName: normalized,
        nativeSessionId: normalizedSessionId,
        operation,
      });
      return true;
    }

    const pending = readPendingInternalOperation();
    const pendingNameMatches = pending
      && (pending.saveName == null
        || normalized === pending.saveName
        || normalizedInternalSaveNames.has(normalized));
    if (pendingNameMatches && sameNativeSession(pending.nativeSessionId, normalizedSessionId)) {
      writePendingInternalOperation(null);
      emit('internal-operation.match', {
        matched: true,
        reason: 'pending-operation',
        saveName: normalized,
        nativeSessionId: normalizedSessionId,
        operation: pending,
      });
      return true;
    }

    // Transitional compatibility only: snapshots produced by older bundles
    // carry the legacy display name but no provenance operation token.
    if (normalizedInternalSaveNames.has(normalized)) {
      emit('internal-operation.match', {
        matched: true,
        reason: 'reserved-name-fallback',
        saveName: normalized,
        nativeSessionId: normalizedSessionId,
        operation: pending,
      });
      return true;
    }
    emit('internal-operation.match', {
      matched: false,
      reason: pending ? 'operation-mismatch' : 'operation-missing',
      saveName: normalized,
      nativeSessionId: normalizedSessionId,
      operation: pending,
    });
    return false;
  }

  function matchesPendingLoadEcho(saveName, nativeSessionId = null) {
    const pending = readPendingLoadEcho();
    if (!pending || normalizedSaveName(saveName) !== pending.saveName) {
      emit('token.match', {
        matched: false,
        reason: pending ? 'save-name-mismatch' : 'token-missing',
        saveName: normalizedSaveName(saveName),
        nativeSessionId: normalizedSaveName(nativeSessionId),
        token: pending,
      });
      return false;
    }
    const normalizedSessionId = normalizedSaveName(nativeSessionId);
    const matched = pending.nativeSessionId == null
      || normalizedSessionId == null
      || normalizedSessionId === pending.nativeSessionId;
    emit('token.match', {
      matched,
      reason: matched ? 'identity-match' : 'native-session-mismatch',
      saveName: normalizedSaveName(saveName),
      nativeSessionId: normalizedSessionId,
      token: pending,
    });
    return matched;
  }

  function observeSaveEcho(saveName, nativeSessionId = null) {
    const normalized = normalizedSaveName(saveName);
    if (Boolean(activeSaveName) && normalized === activeSaveName) {
      const normalizedSessionId = normalizedSaveName(nativeSessionId);
      if (activeNativeSessionId && normalizedSessionId && activeNativeSessionId !== normalizedSessionId) {
        emit('active-save.match', {
          matched: false,
          reason: 'native-session-mismatch',
          saveName: normalized,
          nativeSessionId: normalizedSessionId,
          activeSaveName,
          activeNativeSessionId,
        });
        return false;
      }
      activeLoadObserved = true;
      emit('active-save.match', {
        matched: true,
        saveName: normalized,
        nativeSessionId: normalizedSessionId,
        activeSaveName,
        activeNativeSessionId,
      });
      consumePendingLoadEcho();
      return true;
    }
    if (!matchesPendingLoadEcho(normalized, nativeSessionId)) return false;
    consumePendingLoadEcho();
    return true;
  }

  function clearStaleSaveEcho() {
    if (readPendingLoadEcho()) consumePendingLoadEcho();
  }

  function classifyLoad(saveName, {
    nativeSessionId = null,
    pendingNavigation = false,
  } = {}) {
    emit('classify.input', {
      saveName: normalizedSaveName(saveName),
      nativeSessionId: normalizedSaveName(nativeSessionId),
      pendingNavigation,
      activeSaveName,
      activeNativeSessionId,
      activeLoadObserved,
    });
    if (pendingNavigation) {
      emit('classify.result', { result: 'tile-navigation' });
      return 'tile-navigation';
    }
    if (observeInternalLoad(saveName, nativeSessionId)) {
      if (activeSaveName) {
        activeLoadObserved = true;
        consumePendingLoadEcho();
      }
      emit('classify.result', { result: 'internal-runtime' });
      return 'internal-runtime';
    }
    if (observeSaveEcho(saveName, nativeSessionId)) {
      emit('classify.result', { result: 'save-echo' });
      return 'save-echo';
    }
    // A callback with different save/session identity is positive evidence of
    // a real load. Do not let an old, unconsumed save token mask a later load.
    clearStaleSaveEcho();
    emit('classify.result', { result: 'save-load' });
    return 'save-load';
  }

  function classifySave(saveName, { nativeSessionId = null } = {}) {
    emit('classify-save.input', {
      saveName: normalizedSaveName(saveName),
      nativeSessionId: normalizedSaveName(nativeSessionId),
    });
    const result = observeInternalLoad(saveName, nativeSessionId)
      ? 'internal-runtime'
      : 'native-save';
    emit('classify-save.result', { result });
    return result;
  }

  return {
    async runInternalOperation({
      kind = 'runtime-snapshot',
      saveName = OPEN_WORLD_RUNTIME_SAVE_NAME,
      nativeSessionId = null,
      metadataMarked = false,
    } = {}, action) {
      if (typeof action !== 'function') throw new TypeError('Internal native operation requires an action');
      const ownsOperation = activeInternalOperation == null;
      if (ownsOperation) {
        internalOperationSequence += 1;
        activeInternalOperation = {
          operationId: `${Date.now()}:${internalOperationSequence}`,
          kind: normalizedSaveName(kind) ?? 'runtime-snapshot',
          saveName: normalizedSaveName(saveName),
          nativeSessionId: normalizedSaveName(nativeSessionId),
          metadataMarked: metadataMarked === true,
        };
        writePendingInternalOperation(activeInternalOperation);
        emit('internal-operation.begin', { operation: activeInternalOperation });
      } else {
        emit('internal-operation.nested', {
          operation: activeInternalOperation,
          requestedKind: kind,
        });
      }
      try {
        return await action();
      } finally {
        if (ownsOperation) {
          emit('internal-operation.end', { operation: activeInternalOperation });
          activeInternalOperation = null;
        }
      }
    },

    begin(saveName, nativeSessionId = null) {
      if (activeSaveName) {
        emit('save.begin-rejected', {
          saveName: normalizedSaveName(saveName),
          nativeSessionId: normalizedSaveName(nativeSessionId),
          activeSaveName,
          activeNativeSessionId,
        });
        return false;
      }
      activeSaveName = normalizedSaveName(saveName);
      activeNativeSessionId = normalizedSaveName(nativeSessionId);
      activeLoadObserved = false;
      if (activeSaveName) {
        writePendingLoadEcho({
          saveName: activeSaveName,
          nativeSessionId: activeNativeSessionId,
        });
      }
      emit('save.begin', {
        accepted: Boolean(activeSaveName),
        saveName: activeSaveName,
        nativeSessionId: activeNativeSessionId,
      });
      return Boolean(activeSaveName);
    },

    end() {
      emit('save.end', { activeSaveName, activeNativeSessionId, activeLoadObserved });
      if (activeSaveName && activeLoadObserved) consumePendingLoadEcho();
      activeSaveName = null;
      activeNativeSessionId = null;
      activeLoadObserved = false;
    },

    isActive() {
      return Boolean(activeSaveName);
    },

    isNestedSave(saveName) {
      return Boolean(activeSaveName)
        && (normalizedSaveName(saveName) == null || normalizedSaveName(saveName) === activeSaveName);
    },

    isNestedLoad(saveName, nativeSessionId = null) {
      return observeInternalLoad(saveName, nativeSessionId)
        || observeSaveEcho(saveName, nativeSessionId);
    },

    classifySave,
    classifyLoad,
  };
}
