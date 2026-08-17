(() => {
  const state = window.__subwayBuilder_storeCallbacks__?.getState?.();
  const source = (value) => typeof value === 'function' ? String(value).slice(0, 4000) : value;
  const describe = (value) => value && (typeof value === 'object' || typeof value === 'function')
    ? { type: typeof value, keys: Reflect.ownKeys(value).map(String), source: typeof value === 'function' ? source(value) : undefined }
    : { type: typeof value, value };
  return {
    currentSaveInfo: state?.currentSaveInfo,
    loadItem: source(state?.loadItem),
    generateSave: source(state?.generateSave),
    loadSave: source(state?.loadSave),
    secureElectron: describe(window.__secureElectron),
    secureEntries: Object.fromEntries(Object.entries(window.__secureElectron ?? {}).map(([key, value]) => [key, describe(value)])),
  };
})()
