export const RENDERER_MEMORY_DIAGNOSTICS_VERSION = 'renderer-memory-pressure-v3';
// Keep the key stable across generations so a new bundle can stop the old timer.
export const RENDERER_MEMORY_DIAGNOSTICS_KEY = '__openWorldRendererMemoryDiagnostics__';

const MiB = 1024 * 1024;
const DETAIL_FIELDS = ['phase', 'status', 'tileId', 'reason', 'durationMs', 'rows', 'bytes'];
const INTERPRETATION = 'V8 inspector samples report JS heap separately from backing storage; samples older than three seconds are unavailable. '
  + 'Browser-reported memory is recorded separately as an estimate and never supplies headroom. '
  + 'Worker heaps are sampled separately; combined allocated bytes sum reported heap pages across distinct isolates. '
  + 'Headroom and pressure refer only to the main isolate. They are not renderer-wide free space or a crash prediction. '
  + 'Peaks between samples, shared-page overlap, and complete native/GPU memory are not measured. '
  + 'A heap drop is inferred GC, not a GC notification. Sampling gaps may also reflect background throttling.';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function option(value, fallback, minimum, maximum) {
  return finite(value) == null ? fallback : Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function textLabel(value) {
  return typeof value === 'string' ? value.slice(0, 96) : null;
}

function ring(capacity) {
  const values = new Array(capacity);
  let cursor = 0, size = 0;
  return {
    append(value) {
      values[cursor] = value;
      cursor = (cursor + 1) % capacity;
      size = Math.min(size + 1, capacity);
    },
    snapshot(afterId = 0) {
      const result = [];
      for (let index = 0; index < size; index++) {
        const value = values[(cursor - size + index + capacity) % capacity];
        if (value.id > afterId) result.push({ ...value });
      }
      return result;
    },
  };
}

function heapNumbers(readMemory) {
  try {
    const memory = readMemory();
    const used = finite(memory?.usedJSHeapSize);
    const total = finite(memory?.totalJSHeapSize);
    const limit = finite(memory?.jsHeapSizeLimit);
    return {
      usedBytes: used != null && used >= 0 ? used : null,
      totalBytes: total != null && total > 0 ? total : null,
      limitBytes: limit != null && limit > 0 ? limit : null,
    };
  } catch {
    return { usedBytes: null, totalBytes: null, limitBytes: null };
  }
}

function pressure(usageRatio, headroomBytes) {
  if (usageRatio == null || headroomBytes == null) return 'unavailable';
  if (usageRatio >= 0.90 || headroomBytes <= 128 * MiB) return 'high';
  if (usageRatio >= 0.80 || headroomBytes <= 256 * MiB) return 'elevated';
  return 'normal';
}

/**
 * One cheap sample per second by default, plus explicit activity boundaries.
 * Never walks game state, forces GC, adjusts the heap limit, or stores caller objects.
 * The rings are deliberately renderer-local; an external collector must save snapshots
 * if a capture needs to survive a renderer crash.
 */
export function installRendererMemoryDiagnostics({
  root = globalThis,
  now = () => root.performance?.now?.() ?? Date.now(),
  wallNow = () => Date.now(),
  readMemory = () => root.performance?.memory,
  readV8Memory = null,
  setIntervalFn = (callback, milliseconds) => root.setInterval?.(callback, milliseconds),
  clearIntervalFn = timer => root.clearInterval?.(timer),
  intervalMs = 1000,
  sampleLimit = 300,
  eventLimit = 100,
  activityLimit = 60,
  spikeBytes = 32 * MiB,
  gcDropBytes = 16 * MiB,
  autoStart = true,
  onSample = null,
} = {}) {
  root[RENDERER_MEMORY_DIAGNOSTICS_KEY]?.dispose?.();
  intervalMs = option(intervalMs, 1000, 250, 60_000);
  sampleLimit = option(sampleLimit, 300, 1, 2000);
  eventLimit = option(eventLimit, 100, 1, 500);
  activityLimit = option(activityLimit, 60, 1, 500);
  spikeBytes = option(spikeBytes, 32 * MiB, MiB, 1024 * MiB);
  gcDropBytes = option(gcDropBytes, 16 * MiB, MiB, 1024 * MiB);

  let samples, events, activities, summary, previous, latestActivity, highWater, remoteHeap = null;
  let captureId, captureSequence = 0;
  let timer = null, running = false, disposed = false;
  function clearState() {
    captureId = `${wallNow()}-${now()}-${++captureSequence}`;
    samples = ring(sampleLimit);
    events = ring(eventLimit);
    activities = ring(activityLimit);
    summary = {
      samples: 0, activities: 0, unavailableSamples: 0, growthSpikes: 0,
      inferredGcDrops: 0, samplingGaps: 0, maxObservationGapMs: 0,
      minHeadroomBytes: null, maxUsageRatio: null,
    };
    previous = null;
    latestActivity = null;
    highWater = null;
  }
  clearState();

  function collect(source = 'manual') {
    if (!running || disposed) return null;
    const capturedAt = now();
    const browser = heapNumbers(readMemory);
    let remote;
    try { remote = readV8Memory ? readV8Memory() : remoteHeap; } catch {}
    const measurementAt = typeof remote?.at === 'string' ? Date.parse(remote.at) : finite(remote?.at);
    const requestMs = Math.max(0, finite(remote?.requestMs) ?? 0);
    // Use the query start as the conservative freshness bound, including response delay.
    const measurementAgeMs = Number.isFinite(measurementAt) ? Math.max(0, wallNow() - measurementAt) + requestMs : null;
    const precise = remote?.version === 'renderer-v8-heap-v1' && remote.status === 'available'
      && measurementAgeMs != null && measurementAt - requestMs >= (finite(root.performance?.timeOrigin) ?? 0)
      && measurementAt <= wallNow() + 1000 && measurementAgeMs <= 3000
      && finite(remote.usedBytes) != null && remote.usedBytes >= 0 && finite(remote.limitBytes) > 0;
    const heap = precise ? { usedBytes: remote.usedBytes, totalBytes: finite(remote.totalBytes), limitBytes: remote.limitBytes }
      : { usedBytes: null, totalBytes: null, limitBytes: null };
    const available = heap.usedBytes != null;
    const headroomBytes = available && heap.limitBytes != null
      ? Math.max(0, heap.limitBytes - heap.usedBytes) : null;
    const usageRatio = available && heap.limitBytes != null ? heap.usedBytes / heap.limitBytes : null;
    const gapMs = previous ? Math.max(0, capturedAt - previous.monotonicMs) : null;
    const deltaBytes = available && previous?.usedBytes != null && remote.targetId === previous.targetId && textLabel(remote.isolateId) === previous.isolateId
      ? heap.usedBytes - previous.usedBytes : null;
    const workerAt = typeof remote?.workersAt === 'string' ? Date.parse(remote.workersAt) : finite(remote?.workersAt);
    const workersAgeMs = Number.isFinite(workerAt) ? Math.max(0, wallNow() - workerAt) + Math.max(0, remote.workersRequestMs ?? 0) : null;
    const workersAvailable = precise && remote.workersStatus === 'available' && workersAgeMs != null && workersAgeMs <= 3000
      && finite(remote.workerUsedBytes) != null && remote.workerUsedBytes >= 0
      && finite(remote.workerAllocatedBytes) != null && remote.workerAllocatedBytes >= 0;
    const sample = {
      id: ++summary.samples,
      at: wallNow(),
      monotonicMs: capturedAt,
      source: textLabel(source) ?? 'manual',
      available,
      measurementMode: precise ? 'v8-inspector' : browser.usedBytes != null ? 'estimated' : 'unavailable',
      measurementAt: precise ? measurementAt : null,
      measurementAgeMs,
      targetId: precise ? textLabel(remote.targetId) : null,
      isolateId: precise ? textLabel(remote.isolateId) : null,
      workersAvailable,
      workersAgeMs,
      workerCount: precise ? finite(remote.workerCount) : null,
      workerUsedBytes: workersAvailable ? finite(remote.workerUsedBytes) : null,
      workerAllocatedBytes: workersAvailable ? finite(remote.workerAllocatedBytes) : null,
      workerBackingStorageBytes: workersAvailable ? finite(remote.workerBackingStorageBytes) : null,
      allIsolatesUsedBytes: workersAvailable ? heap.usedBytes + remote.workerUsedBytes : null,
      allIsolatesAllocatedBytes: workersAvailable && heap.totalBytes != null ? heap.totalBytes + remote.workerAllocatedBytes : null,
      browserUsedBytes: browser.usedBytes,
      backingStorageBytes: precise ? finite(remote.backingStorageBytes) : null,
      embedderBytes: precise ? finite(remote.embedderBytes) : null,
      ...heap,
      headroomBytes,
      usageRatio,
      pressure: pressure(usageRatio, headroomBytes),
      gapMs,
      deltaBytes,
      activity: latestActivity?.activity ?? null,
      activityId: latestActivity?.id ?? null,
      activityAgeMs: latestActivity ? Math.max(0, capturedAt - latestActivity.monotonicMs) : null,
    };
    samples.append(sample);
    if (!available) summary.unavailableSamples++;
    if (available && (highWater == null || heap.usedBytes > highWater.usedBytes)) highWater = sample;
    if (headroomBytes != null) {
      summary.minHeadroomBytes = Math.min(summary.minHeadroomBytes ?? Infinity, headroomBytes);
      summary.maxUsageRatio = Math.max(summary.maxUsageRatio ?? 0, usageRatio);
    }
    summary.maxObservationGapMs = Math.max(summary.maxObservationGapMs, gapMs ?? 0);
    const event = kind => events.append({ kind, ...sample });
    if (gapMs != null && gapMs > intervalMs * 2) {
      summary.samplingGaps++;
      event('sampling-gap');
    }
    if (deltaBytes != null && deltaBytes >= spikeBytes) {
      summary.growthSpikes++;
      event('heap-growth');
    }
    if (deltaBytes != null && deltaBytes <= -gcDropBytes) {
      summary.inferredGcDrops++;
      event('heap-drop-inferred-gc');
    }
    if (previous ? previous.pressure !== sample.pressure : ['elevated', 'high'].includes(sample.pressure)) {
      event('pressure-change');
    }
    previous = sample;
    // Consumers may react to pressure using these scalars, never a game-state snapshot.
    try { onSample?.({ ...sample }); } catch {}
    return sample;
  }

  function status() {
    return { version: RENDERER_MEMORY_DIAGNOSTICS_VERSION, running, intervalMs };
  }

  function start() {
    if (running || disposed) return status();
    running = true;
    // A deliberate pause in monitoring is not an observed event-loop stall.
    previous = null;
    collect('start');
    timer = setIntervalFn(() => { collect('interval'); }, intervalMs) ?? null;
    timer?.unref?.();
    return status();
  }

  function stop() {
    if (timer != null) clearIntervalFn(timer);
    timer = null;
    running = false;
    return status();
  }

  function reset() {
    clearState();
    if (running) collect('reset');
    return status();
  }

  function snapshot({ includeHistory = true, afterSampleId = 0, afterActivityId = 0, captureId: previousCaptureId } = {}) {
    const sameCapture = previousCaptureId === captureId;
    return {
      ...status(),
      captureId,
      interpretation: INTERPRETATION,
      limits: { sampleLimit, eventLimit, activityLimit, spikeBytes, gcDropBytes },
      summary: { ...summary },
      latest: previous ? { ...previous } : null,
      highWater: highWater ? { ...highWater } : null,
      ...(includeHistory ? { samples: samples.snapshot() } : {}),
      events: events.snapshot(sameCapture ? afterSampleId : 0),
      activities: activities.snapshot(sameCapture ? afterActivityId : 0),
    };
  }

  function recordActivity(activity, details = {}) {
    if (!running || disposed) return null;
    const label = textLabel(activity);
    if (!label) return null;
    const record = { id: ++summary.activities, at: wallNow(), monotonicMs: now(), activity: label };
    // Copy only known primitive scalars. Never enumerate/stringify arbitrary caller data.
    for (const field of DETAIL_FIELDS) {
      let value;
      try { value = details?.[field]; } catch { continue; }
      if (typeof value === 'string') record[field] = textLabel(value);
      else if (typeof value === 'boolean' || finite(value) != null) record[field] = value;
    }
    latestActivity = record;
    activities.append(record);
    collect('activity');
    return { ...record };
  }

  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
    remoteHeap = null;
    clearState();
    if (root[RENDERER_MEMORY_DIAGNOSTICS_KEY] === api) delete root[RENDERER_MEMORY_DIAGNOSTICS_KEY];
    for (const [name, callback] of Object.entries(debugApi)) {
      if (root[name] === callback) delete root[name];
    }
  }

  const api = Object.freeze({
    version: RENDERER_MEMORY_DIAGNOSTICS_VERSION,
    start, stop, reset, snapshot, recordActivity, dispose,
    acceptHeapMeasurement(value) {
      if (disposed) return;
      // Copy only expected scalar fields from the local recorder; retain no response tree.
      remoteHeap = value?.version === 'renderer-v8-heap-v1' ? {
        version: value.version, status: textLabel(value.status), at: typeof value.at === 'string' ? textLabel(value.at) : finite(value.at),
        targetId: textLabel(value.targetId), isolateId: textLabel(value.isolateId), usedBytes: finite(value.usedBytes), totalBytes: finite(value.totalBytes),
        limitBytes: finite(value.limitBytes), backingStorageBytes: finite(value.backingStorageBytes), embedderBytes: finite(value.embedderBytes),
        requestMs: finite(value.requestMs),
        workersStatus: value.workers?.version === 'worker-v8-heap-v1' ? textLabel(value.workers.status) : null,
        workersAt: typeof value.workers?.at === 'string' ? textLabel(value.workers.at) : finite(value.workers?.at),
        workersRequestMs: finite(value.workers?.requestMs), workerCount: finite(value.workers?.workerCount),
        workerUsedBytes: finite(value.workers?.usedBytes), workerAllocatedBytes: finite(value.workers?.totalBytes),
        workerBackingStorageBytes: finite(value.workers?.backingStorageBytes),
      } : null;
    },
    sample(source) { const sample = collect(source); return sample ? { ...sample } : null; },
  });
  const debugApi = {
    __enableOpenWorldRendererMemoryDebug(configuration = true) {
      if (configuration?.reset === true) reset();
      return configuration === false ? stop() : start();
    },
    __clearOpenWorldRendererMemoryDiagnostic: reset,
    __printOpenWorldRendererMemoryDiagnostic() {
      const report = snapshot();
      root.console?.info?.('[OpenWorld renderer memory]', report);
      return report;
    },
  };
  root[RENDERER_MEMORY_DIAGNOSTICS_KEY] = api;
  Object.assign(root, debugApi);
  if (autoStart) start();
  return api;
}
