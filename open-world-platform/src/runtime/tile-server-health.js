const HEALTH_STATE = Symbol.for('open-world.shared-tile-server-health-v1');
const EXPECTED_SERVER_VERSION = 'native-pmtiles-directory-v4';

function healthUrl(tileBase) {
  return `${String(tileBase).replace(/\/+$/, '')}/_health`;
}

export async function checkSharedTileServerHealth({
  tileBase,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  notify = null,
  globalObject = globalThis,
  timeoutMilliseconds = 2_000,
} = {}) {
  if (typeof fetchImpl !== 'function') return { status: 'unavailable', reason: 'fetch-unavailable' };
  const prior = globalObject[HEALTH_STATE];
  if (prior?.reported) return { status: 'already-reported' };
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
      notify?.(
        "Open World tile server isn't running. Open Subway Builder Open World from the Start menu.",
        'error',
        'Open World',
      );
      return { status: 'unavailable', reason: error?.message ?? String(error) };
    } finally {
      if (timeout != null) clearTimeout(timeout);
    }
  })();
  globalObject[HEALTH_STATE] = { pending, reported: false };
  return pending;
}
