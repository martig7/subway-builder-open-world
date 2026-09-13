export const RENDERER_DEBUG_RECORDER_VERSION = 'renderer-debug-recorder-v1';
export const RENDERER_DEBUG_RECORDER_GENERATION = 'renderer-debug-recorder-runtime-v3';
const KEY = '__openWorldRendererDebugRecorder__';
const FIELDS = ['id', 'at', 'monotonicMs', 'kind', 'source', 'available', 'usedBytes', 'totalBytes',
  'limitBytes', 'headroomBytes', 'usageRatio', 'pressure', 'gapMs', 'deltaBytes', 'activity', 'activityId',
  'activityAgeMs', 'phase', 'status', 'tileId', 'reason', 'durationMs', 'rows', 'bytes',
  'manifestId', 'cityCode', 'zoom', 'longitude', 'latitude', 'measurementMode', 'measurementAt',
  'measurementAgeMs', 'targetId', 'browserUsedBytes', 'backingStorageBytes', 'embedderBytes', 'isolateId',
  'workersAvailable', 'workersAgeMs', 'workerCount', 'workerUsedBytes', 'workerAllocatedBytes', 'workerBackingStorageBytes',
  'allIsolatesUsedBytes', 'allIsolatesAllocatedBytes'];

function scalars(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of FIELDS) {
    const item = value[key];
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
    else if (typeof item === 'string') result[key] = item.slice(0, 128);
  }
  return result;
}

export function recorderPayload(snapshot, context, clientId) {
  return {
    version: RENDERER_DEBUG_RECORDER_VERSION, clientId, captureId: String(snapshot.captureId).slice(0, 128),
    context: scalars(context), latest: scalars(snapshot.latest), highWater: scalars(snapshot.highWater),
    events: (snapshot.events ?? []).slice(-16).map(scalars),
    activities: (snapshot.activities ?? []).slice(-16).map(scalars),
  };
}

/** One request at a time. The independent tile server owns the switch and disk retention. */
export function installRendererDebugRecorder({ baseUrl, getSnapshot, getContext = () => ({}), root = globalThis,
  onHeapMeasurement = () => {},
  fetchImpl = root.fetch?.bind(root), setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis), autoStart = true } = {}) {
  root[KEY]?.dispose?.();
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Recorder requires a local tile server');
  const endpoint = url.origin + '/_diagnostics/recorder';
  const clientId = root.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let disposed = false, timer = null, abort = null, busy = false, enabled = false, status = 'checking';
  let cursor = {}, sent = 0, failures = 0;

  async function tick() {
    if (disposed || busy || !fetchImpl) return;
    busy = true;
    abort = new AbortController();
    const timeout = setTimeoutFn(() => abort?.abort(), 3000);
    let delay = 5000;
    try {
      let payload;
      if (enabled) payload = recorderPayload(getSnapshot({ includeHistory: false, ...cursor }), getContext(), clientId);
      const body = payload ? JSON.stringify(payload) : undefined;
      if (body && new TextEncoder().encode(body).byteLength > 32 * 1024) throw Error('Recorder sample exceeds its bound');
      const response = await fetchImpl(endpoint + (payload ? '/sample' : ''), {
        method: payload ? 'POST' : 'GET', cache: 'no-store', signal: abort.signal,
        ...(payload ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      });
      if (!response.ok) throw Error(`Recorder HTTP ${response.status}`);
      const result = await response.json();
      if (disposed) return;
      if (result.version !== RENDERER_DEBUG_RECORDER_VERSION) throw Error('Recorder unavailable');
      try { onHeapMeasurement(result.heap); } catch {}
      enabled = result.enabled === true;
      status = enabled ? 'recording' : 'off';
      if (payload && enabled) {
        sent++;
        cursor = { captureId: payload.captureId, afterSampleId: payload.latest?.id ?? 0,
          afterActivityId: payload.activities.at(-1)?.id ?? (cursor.captureId === payload.captureId ? cursor.afterActivityId : 0) ?? 0 };
      }
      if (!enabled) cursor = {};
      delay = enabled ? 1000 : 5000;
    } catch {
      try { onHeapMeasurement(null); } catch {}
      if (!disposed) { failures++; enabled = false; status = 'unavailable'; }
    } finally {
      clearTimeoutFn(timeout);
      abort = null;
      busy = false;
      if (!disposed && autoStart) timer = setTimeoutFn(tick, delay);
    }
  }

  const api = {
    generation: RENDERER_DEBUG_RECORDER_GENERATION,
    version: RENDERER_DEBUG_RECORDER_VERSION, tick,
    snapshot: () => ({ version: RENDERER_DEBUG_RECORDER_VERSION, enabled, status, sent, failures, pending: busy }),
    dispose() {
      disposed = true;
      clearTimeoutFn(timer);
      abort?.abort();
      cursor = {};
      try { onHeapMeasurement(null); } catch {}
      if (root[KEY] === api) delete root[KEY];
    },
  };
  root[KEY] = api;
  if (autoStart && fetchImpl && setTimeoutFn) timer = setTimeoutFn(tick, 0);
  return api;
}
