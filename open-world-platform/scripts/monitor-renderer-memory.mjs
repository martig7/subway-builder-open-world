/**
 * External, read-only Subway Builder renderer memory recorder (Node 22+).
 * Start the game with its existing local CDP endpoint available, then run:
 *   node open-world-platform/scripts/monitor-renderer-memory.mjs --output .analysis/renderer-memory-20260912.jsonl --duration-seconds 900
 * Optional: --url http://127.0.0.1:9222 --interval-ms 1000 --timeout-ms 5000
 * The output must be a NEW file; existing captures are never overwritten.
 * Ctrl+C closes the connection and finishes the file. No forced GC, injected
 * timers, game-state changes, Runtime.enable, or heap snapshots are used.
 *
 * Heap measurements come from Runtime.getHeapUsage. Backing-store and embedder
 * figures are recorded separately, not added to usedSize as a presumed total.
 * https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage
 * The mod's performance.memory values can be quantized and cached by Chromium;
 * use the separate CDP sample records for timely measurements. Browser-reported
 * heap can include external memory; these figures are not process RSS or GPU totals.
 * https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/timing/memory_info.cc
 * Runtime diagnostics are optional; this still records heap when no mod is loaded.
 * A freeze leaves ONE request outstanding while HTTP target discovery checks for
 * a vanished/replaced renderer. It never queues repeated evaluations during a stall.
 * JSONL records survive renderer crashes; samples cannot observe every transient
 * peak or determine that a timeout necessarily means an out-of-memory crash.
 */
import { openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_BYTES = 256 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SHORT_FIELDS = ['id', 'at', 'monotonicMs', 'kind', 'source', 'available', 'usedBytes', 'totalBytes',
  'limitBytes', 'headroomBytes', 'usageRatio', 'pressure', 'gapMs', 'deltaBytes', 'activity', 'activityId',
  'activityAgeMs', 'phase', 'status', 'tileId', 'reason', 'durationMs', 'rows', 'bytes'];

function short(value, limit = 160) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function scalars(value, fields = SHORT_FIELDS) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of fields) {
    const item = value[field];
    if (item === null || typeof item === 'boolean' || number(item) != null) result[field] = item;
    else if (typeof item === 'string') result[field] = short(item);
  }
  return result;
}

export function parseMonitorOptions(args) {
  const names = new Set(['--url', '--output', '--duration-seconds', '--interval-ms', '--timeout-ms']);
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (!names.has(key) || values.has(key)) throw Error(`Unknown or repeated option: ${key}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  if (!values.get('--output')?.trim()) throw Error('--output is required (an explicit new JSONL file path)');
  const url = new URL(values.get('--url') ?? 'http://127.0.0.1:9222');
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw Error('--url must be a loopback HTTP origin');
  function bounded(key, fallback, min, max) {
    if (!values.has(key)) return fallback;
    const value = Number(values.get(key));
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  }
  return {
    url: url.origin,
    output: resolve(values.get('--output')),
    durationMs: bounded('--duration-seconds', 900, 1, 86_400) * 1000,
    intervalMs: bounded('--interval-ms', 1000, 500, 60_000),
    timeoutMs: bounded('--timeout-ms', 5000, 1000, 60_000),
  };
}

export function selectGameTarget(targets, origin) {
  const matches = Array.isArray(targets) ? targets.filter(target => {
    if (target.type !== 'page' || !/^Subway Builder(?:\s|$)/i.test(target.title ?? '')) return false;
    try {
      const page = new URL(target.url);
      return /\/dist\/renderer\/index\.html$/.test(page.pathname);
    } catch { return false; }
  }) : [];
  if (matches.length > 1) throw Error('Multiple Subway Builder renderers found; close the unintended game instance');
  if (!matches.length) return null;
  const target = matches[0];
  const socket = new URL(target.webSocketDebuggerUrl);
  if (socket.protocol !== 'ws:' || !LOOPBACK.has(socket.hostname) || socket.username || socket.password
    || socket.port !== new URL(origin).port) throw Error('Renderer websocket must use the selected loopback CDP port');
  return { id: short(target.id), title: short(target.title), webSocketDebuggerUrl: socket.href };
}

export function compactMemorySnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    version: short(value.version), captureId: short(value.captureId), running: value.running === true,
    latest: scalars(value.latest), highWater: scalars(value.highWater),
    summary: scalars(value.summary, ['samples', 'activities', 'unavailableSamples', 'growthSpikes',
      'inferredGcDrops', 'samplingGaps', 'maxObservationGapMs', 'minHeadroomBytes', 'maxUsageRatio']),
    events: Array.isArray(value.events) ? value.events.slice(-16).map(event => scalars(event)) : [],
    activities: Array.isArray(value.activities) ? value.activities.slice(-8).map(event => scalars(event)) : [],
    omittedEvents: number(value.omittedEvents) ?? Math.max(0, (value.events?.length ?? 0) - 16),
    omittedActivities: number(value.omittedActivities) ?? Math.max(0, (value.activities?.length ?? 0) - 8),
  };
}

// One slot, not an unbounded pending-request map. A timeout does not free the
// slot: only its response or a closed connection permits another command.
export class SequentialCdpClient {
  constructor(socket, onEvent = () => {}) {
    this.socket = socket;
    this.pending = null;
    this.nextId = 1;
    this.closed = false;
    socket.addEventListener('message', event => {
      if (this.closed) return;
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) {
        this.close(Error('CDP message exceeded the bounded collector limit')); return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { this.close(Error('Malformed CDP message')); return; }
      if (message.id === this.pending?.id) {
        const pending = this.pending;
        this.pending = null;
        if (message.error) pending.reject(Error(short(message.error.message) ?? 'CDP error'));
        else pending.resolve(message.result);
      } else if (message.method === 'Inspector.targetCrashed' || message.method === 'Inspector.detached') {
        onEvent(message.method, short(message.params?.reason));
        this.close(Error(message.method));
      }
    });
    socket.addEventListener('close', () => this.close(Error('Renderer disconnected')));
    socket.addEventListener('error', () => this.close(Error('Renderer websocket error')));
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(Error('Renderer disconnected'));
    if (this.pending) return Promise.reject(Error('A CDP request is already outstanding'));
    return new Promise((resolveCall, reject) => {
      this.pending = { id: this.nextId++, resolve: resolveCall, reject };
      try { this.socket.send(JSON.stringify({ id: this.pending.id, method, params })); }
      catch (error) { this.close(error); }
    });
  }
  close(error = Error('Collector stopped')) {
    if (this.closed) return;
    this.closed = true;
    this.pending?.reject(error);
    this.pending = null;
    try { this.socket.close(); } catch {}
  }
}

function delay(milliseconds, signal) {
  return new Promise(resolveDelay => {
    if (signal.aborted) { resolveDelay(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolveDelay(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function discover(options, signal, fetchFn = fetch) {
  const response = await fetchFn(`${options.url}/json/list`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
  });
  if (!response.ok) throw Error(`CDP discovery HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_MESSAGE_BYTES) throw Error('CDP discovery response exceeded the collector limit');
  return selectGameTarget(JSON.parse(body), options.url);
}

async function connect(target, options, signal, onEvent, WebSocketCtor = WebSocket) {
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl);
  const client = new SequentialCdpClient(socket, onEvent);
  await new Promise((resolveOpen, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = error => { cleanup(); client.close(error); reject(error); };
    const abort = () => fail(Error('Collector stopped'));
    const timer = setTimeout(() => fail(Error('CDP connection timed out')), options.timeoutMs);
    socket.addEventListener('open', () => { cleanup(); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => fail(Error('CDP connection failed')), { once: true });
    socket.addEventListener('close', () => fail(Error('CDP connection closed')), { once: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return client;
}

function diagnosticExpression(cursor) {
  return `(() => {
    const d = globalThis.__openWorldRendererMemoryDiagnostics__?.snapshot(${JSON.stringify({ includeHistory: false, ...cursor })});
    const memory = globalThis.performance?.memory;
    return { timeOrigin: globalThis.performance?.timeOrigin ?? null,
      reportedLimitBytes: memory?.jsHeapSizeLimit ?? null,
      diagnostic: d ? { version:d.version, captureId:d.captureId, running:d.running, latest:d.latest,
        highWater:d.highWater, summary:d.summary, events:d.events.slice(-16), activities:d.activities.slice(-8),
        omittedEvents:Math.max(0,d.events.length-16), omittedActivities:Math.max(0,d.activities.length-8) } : null };
  })()`;
}

export async function monitorRendererMemory(options, { signal, fetchFn = fetch, WebSocketCtor = WebSocket } = {}) {
  if (!signal) signal = new AbortController().signal;
  const fd = openSync(options.output, 'wx');
  const emit = record => writeFileSync(fd, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
  let client = null, previousTarget = null, previousTimeOrigin = null, lastSampleAt = null;
  let cursor = {}, retryMs = 1000, state = null;
  const setState = (next, details = {}) => {
    if (state !== next) { state = next; emit({ kind: next, ...details }); }
  };
  const stopConnection = () => client?.close();
  signal.addEventListener('abort', stopConnection);
  // Waiting keeps the original command attached. HTTP discovery can notice a
  // crash/replacement without enqueuing any more renderer JavaScript work.
  async function request(target, method, params = {}) {
    const began = Date.now();
    let outcome = null, wake = null;
    client.call(method, params).then(
      value => { outcome = { value }; wake?.(); },
      error => { outcome = { error }; wake?.(); },
    );
    let timedOut = false;
    while (!signal.aborted) {
      await new Promise(resolveWait => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolveWait(); };
        const timer = setTimeout(finish, timedOut ? 5000 : options.timeoutMs);
        wake = finish;
        signal.addEventListener('abort', finish, { once: true });
        if (outcome || signal.aborted) finish();
      });
      wake = null;
      if (outcome) {
        if (outcome.error) throw outcome.error;
        if (timedOut) setState('responsive', { waitedMs: Date.now() - began, method });
        return outcome.value;
      }
      if (signal.aborted) break;
      if (!timedOut) { timedOut = true; setState('unresponsive', { waitedMs: Date.now() - began, method }); }
      let current;
      try { current = await discover(options, signal, fetchFn); } catch { continue; }
      if (!current || current.id !== target.id || current.webSocketDebuggerUrl !== target.webSocketDebuggerUrl) {
        client.close(Error('Renderer disappeared or was replaced')); break;
      }
    }
    throw Error(signal.aborted ? 'Collector stopped' : 'Renderer disappeared or was replaced');
  }
  try {
    emit({ kind: 'started', intervalMs: options.intervalMs, timeoutMs: options.timeoutMs, url: options.url });
    while (!signal.aborted) {
      try {
        const target = await discover(options, signal, fetchFn);
        if (!target) { setState('waiting-for-renderer'); await delay(retryMs, signal); retryMs = Math.min(10_000, retryMs * 2); continue; }
        client = await connect(target, options, signal, (event, reason) => {
          setState(event === 'Inspector.targetCrashed' ? 'renderer-crashed' : 'renderer-detached', { reason });
        }, WebSocketCtor);
        setState('connected', { targetId: target.id, title: target.title });
        if (previousTarget && previousTarget !== target.id) emit({ kind: 'renderer-replaced', targetId: target.id });
        previousTarget = target.id;
        await request(target, 'Inspector.enable');
        while (!signal.aborted && !client.closed) {
          const startedAt = Date.now();
          const heap = await request(target, 'Runtime.getHeapUsage');
          const heapCapturedAt = Date.now();
          const gapMs = lastSampleAt == null ? null : heapCapturedAt - lastSampleAt;
          if (gapMs > options.intervalMs * 2) emit({ kind: 'observation-gap', gapMs });
          const usedBytes = number(heap.usedSize);
          // Persist this response before evaluating JS: a subsequent freeze/crash
          // must not erase an already received precise heap measurement.
          emit({ kind: 'sample', targetId: target.id, heapCapturedAt, gapMs,
            roundTripMs: heapCapturedAt - startedAt, usedBytes, totalBytes: number(heap.totalSize),
            backingStorageBytes: number(heap.backingStorageSize), embedderHeapUsedBytes: number(heap.embedderHeapUsedSize) });
          lastSampleAt = heapCapturedAt;
          const evaluated = await request(target, 'Runtime.evaluate', {
            expression: diagnosticExpression(cursor), returnByValue: true, silent: true, generatePreview: false,
          });
          if (evaluated.exceptionDetails) throw Error('Renderer diagnostic expression failed');
          const value = evaluated.result?.value;
          const diagnostic = compactMemorySnapshot(value?.diagnostic);
          const timeOrigin = number(value?.timeOrigin);
          if (previousTimeOrigin != null && timeOrigin != null && previousTimeOrigin !== timeOrigin) {
            emit({ kind: 'renderer-reloaded', timeOrigin });
          }
          previousTimeOrigin = timeOrigin;
          const capturedAt = Date.now();
          const limitBytes = number(value?.reportedLimitBytes);
          emit({ kind: 'diagnostic', heapCapturedAt, diagnosticCapturedAt: capturedAt,
            limitBytes, headroomBytes: limitBytes > 0 && usedBytes != null ? Math.max(0, limitBytes - usedBytes) : null,
            diagnostic });
          if (diagnostic) cursor = { captureId: diagnostic.captureId,
            afterSampleId: diagnostic.latest?.id ?? 0, afterActivityId: diagnostic.summary?.activities ?? 0 };
          retryMs = 1000;
          await delay(Math.max(0, options.intervalMs - (Date.now() - startedAt)), signal);
        }
      } catch (error) {
        if (!signal.aborted) setState(client ? 'disconnected' : 'waiting-for-renderer', { reason: short(error.message) });
      } finally {
        client?.close(); client = null;
      }
      if (!signal.aborted) { await delay(retryMs, signal); retryMs = Math.min(10_000, retryMs * 2); }
    }
  } finally {
    signal.removeEventListener('abort', stopConnection);
    client?.close();
    emit({ kind: 'stopped', lastSampleAt });
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let timer;
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    const options = parseMonitorOptions(process.argv.slice(2));
    if (options.help) console.log('Usage: node monitor-renderer-memory.mjs --output NEW_FILE.jsonl [--duration-seconds 900] [--url http://127.0.0.1:9222] [--interval-ms 1000] [--timeout-ms 5000]');
    else {
      timer = setTimeout(stop, options.durationMs);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      console.log(`Recording renderer memory to ${options.output}`);
      await monitorRendererMemory(options, { signal: controller.signal });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
