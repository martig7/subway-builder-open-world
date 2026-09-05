const HEALTH_STATE = Symbol.for('open-world.shared-tile-server-health-v2');
const MONITOR_STATE = Symbol.for('open-world.shared-tile-server-monitor-v1');
const EXPECTED_SERVER_VERSION = 'native-pmtiles-directory-v4';
const WARNING_ID = 'open-world-tile-server-loading-warning';

function healthUrl(tileBase) {
  return `${String(tileBase).replace(/\/+$/, '')}/_health`;
}

export async function checkSharedTileServerHealth({
  tileBase,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  notify = null,
  globalObject = globalThis,
  timeoutMilliseconds = 2_000,
  force = false,
} = {}) {
  if (typeof fetchImpl !== 'function') return { status: 'unavailable', reason: 'fetch-unavailable' };
  const prior = globalObject[HEALTH_STATE];
  if (prior?.reported && !force) return { status: 'already-reported' };
  if (prior?.pending) return prior.pending;

  const pending = (async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), timeoutMilliseconds)
      : null;
    try {
      const response = await fetchImpl(healthUrl(tileBase), controller ? { signal: controller.signal } : undefined);
      const version = response?.headers?.get?.('X-PMTiles-Server-Version') ?? null;
      if (!response?.ok || version !== EXPECTED_SERVER_VERSION) {
        throw new Error('Unexpected tile-server health response');
      }
      globalObject[HEALTH_STATE] = { status: 'running', checkedAt: Date.now() };
      return { status: 'running', version };
    } catch (error) {
      globalObject[HEALTH_STATE] = { status: 'unavailable', reported: true, checkedAt: Date.now() };
      if (!prior?.reported) {
        try {
          notify?.(
            "Open World tile server isn't running. Open Subway Builder Open World from the Start menu.",
            'error',
            'Open World',
          );
        } catch {}
      }
      return { status: 'unavailable', reason: error?.message ?? String(error) };
    } finally {
      if (timeout != null) clearTimeout(timeout);
    }
  })();
  globalObject[HEALTH_STATE] = { pending, reported: false };
  return pending;
}

function showLoadingWarning(documentObject) {
  const parent = documentObject?.body ?? documentObject?.documentElement;
  if (!parent || typeof documentObject?.createElement !== 'function') return null;
  const existing = documentObject.getElementById?.(WARNING_ID);
  if (existing) return existing;

  const warning = documentObject.createElement('div');
  warning.id = WARNING_ID;
  warning.setAttribute?.('role', 'alert');
  warning.setAttribute?.('aria-live', 'assertive');
  warning.textContent = 'Open World tile server is not running.\nOpen Subway Builder Open World from the Start menu, then select Start.';
  Object.assign(warning.style, {
    position: 'fixed',
    top: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    boxSizing: 'border-box',
    width: 'min(560px, calc(100vw - 48px))',
    padding: '14px 18px',
    border: '1px solid #8c8c8c',
    borderLeft: '4px solid #c42b1c',
    borderRadius: '4px',
    background: '#ffffff',
    color: '#1a1a1a',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
    font: '600 14px/1.45 "Segoe UI", sans-serif',
    whiteSpace: 'pre-line',
    pointerEvents: 'none',
  });
  parent.appendChild(warning);
  return warning;
}

function clearLoadingWarning(documentObject) {
  const warning = documentObject?.getElementById?.(WARNING_ID);
  if (!warning?.parentNode) return;
  warning.parentNode.removeChild(warning);
}

export async function monitorSharedTileServerHealth({
  tileBase,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  notify = null,
  globalObject = globalThis,
  documentObject = globalThis.document,
  timeoutMilliseconds = 2_000,
  retryMilliseconds = 2_000,
  scheduleRetry = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  const existing = globalObject[MONITOR_STATE];
  if (existing?.active) return existing.initial;

  const state = { active: true, initial: null, retryHandle: null };
  globalObject[MONITOR_STATE] = state;

  const poll = async (force) => {
    const result = await checkSharedTileServerHealth({
      tileBase,
      fetchImpl,
      notify,
      globalObject,
      timeoutMilliseconds,
      force,
    });
    if (result.status === 'running') {
      state.active = false;
      clearLoadingWarning(documentObject);
      if (globalObject[MONITOR_STATE] === state) delete globalObject[MONITOR_STATE];
      return result;
    }

    showLoadingWarning(documentObject);
    state.retryHandle = scheduleRetry(() => {
      state.retryHandle = null;
      return poll(true);
    }, retryMilliseconds);
    return result;
  };

  state.initial = poll(false);
  return state.initial;
}
