function normalizedSaveName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Native generateSave fires onGameSaved before it returns its payload. A
 * checkpoint captures a snapshot through generateSave as well, so the hook
 * must not start another checkpoint while the first one is still running.
 */
export function createAutosaveHookGuard() {
  let activeSaveName = null;

  return {
    begin(saveName) {
      if (activeSaveName) return false;
      activeSaveName = normalizedSaveName(saveName);
      return Boolean(activeSaveName);
    },

    end() {
      activeSaveName = null;
    },

    isActive() {
      return Boolean(activeSaveName);
    },

    isNestedSave(saveName) {
      return Boolean(activeSaveName)
        && (normalizedSaveName(saveName) == null || normalizedSaveName(saveName) === activeSaveName);
    },

    isNestedLoad(saveName) {
      return Boolean(activeSaveName)
        && normalizedSaveName(saveName) === activeSaveName;
    },
  };
}
