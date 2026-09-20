export const RUNTIME_MODE_PREFERENCES_VERSION = 'runtime-mode-preferences-v1';

// These are user choices, not simulation state or Native Save authority. Each
// runnable mod owns just two booleans; caches, tokens and save data stay out.
export function createRuntimeModePreferences({ modId, storage, initialChoices } = {}) {
  const key = `open-world:mode-preferences-v1:${modId}`;
  const listeners = new Set();
  let choices = { ultraHighSpeed: false, experimentalAutosaves: false };
  let persisted = false, error = null;
  try {
    storage ??= globalThis.localStorage;
    const raw = storage?.getItem(key);
    if (raw != null) {
      const saved = raw.length <= 4096 ? JSON.parse(raw) : null;
      if (saved?.schemaVersion === 1) {
        for (const name of Object.keys(choices)) if (typeof saved[name] === 'boolean') choices[name] = saved[name];
        persisted = true;
      }
    } else if (initialChoices) {
      // Preserve the current UI choices when upgrading a running older mod.
      for (const name of Object.keys(choices)) if (typeof initialChoices[name] === 'boolean') choices[name] = initialChoices[name];
      write();
    }
  } catch (failure) { error = String(failure?.message ?? failure); }
  function write() {
    try {
      storage?.setItem(key, JSON.stringify({ schemaVersion: 1, ...choices }));
      persisted = typeof storage?.setItem === 'function';
      error = null;
    } catch (failure) { persisted = false; error = String(failure?.message ?? failure); }
  }
  const snapshot = () => ({ version: RUNTIME_MODE_PREFERENCES_VERSION, ...choices, persisted, error });
  function set(name, value) {
    choices = { ...choices, [name]: Boolean(value) };
    write();
    for (const listener of listeners) listener(snapshot());
    return snapshot();
  }
  return {
    snapshot,
    setUltraHighSpeed: value => set('ultraHighSpeed', value),
    setExperimentalAutosaves: value => set('experimentalAutosaves', value),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
