(async () => {
  const describe = (value) => value == null ? null : ({
    type: typeof value,
    constructor: value?.constructor?.name ?? null,
    ownKeys: (typeof value === 'object' || typeof value === 'function') ? Reflect.ownKeys(value).map(String) : [],
  });
  return ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  localStorage: Object.keys(localStorage).map((key) => ({ key, length: localStorage.getItem(key)?.length ?? 0 })),
  sessionStorage: Object.keys(sessionStorage).map((key) => ({ key, length: sessionStorage.getItem(key)?.length ?? 0 })),
  globals: Object.keys(window).filter((key) => /save|state|store|game|subway|metro|world|mod/i.test(key)).sort(),
  diagnosticKeys: Object.keys(window).filter((key) => key.startsWith('__')).sort(),
  api: describe(window.SubwayBuilderAPI),
  apiEntries: Object.fromEntries(Object.entries(window.SubwayBuilderAPI ?? {}).map(([key, value]) => [key, describe(value)])),
  callbackStore: describe(window.__subwayBuilder_storeCallbacks__),
  diagnostics: describe(window.__nyStatePilotDiagnostics__),
});
})()
