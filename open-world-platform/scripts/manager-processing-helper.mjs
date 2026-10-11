import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import { createCrossModeShareWorkerHandler } from '../src/workers/cross-mode-share-worker.js';

export const MANAGER_PROCESSING_HELPER_VERSION = 'manager-processing-helper-v1';
export const processingReplacer = (_, value) => value instanceof Map
  ? { __openWorldType: 'Map', entries: [...value] }
  : value instanceof Set ? { __openWorldType: 'Set', entries: [...value] } : value;
export const processingReviver = (_, value) => value?.__openWorldType === 'Map' && Array.isArray(value.entries)
  ? new Map(value.entries) : value?.__openWorldType === 'Set' && Array.isArray(value.entries) ? new Set(value.entries) : value;

async function emit(value) {
  const text = JSON.stringify(value, processingReplacer);
  if (text.length > 4 * 1024 * 1024) throw new Error('Processing message exceeds its bound');
  if (!process.stdout.write(text + '\n')) await once(process.stdout, 'drain');
}

// Return large results as independently parsed pieces, avoiding a second giant
// JSON string alongside the assembled result in the game.
export async function emitProcessingValue(value, send = emit, location = []) {
  const text = JSON.stringify(value, processingReplacer);
  if (text === undefined) return;
  if (text.length <= 128 * 1024) { await send({ type: 'value', path: location, value }); return; }
  if (value instanceof Map || value instanceof Set) {
    await send({ type: 'open', path: location, collection: value instanceof Map ? 'Map' : 'Set' });
    let batch = [], length = 0;
    const flush = async () => { if (batch.length) await send({ type: 'entries', path: location, entries: batch }); batch = []; length = 0; };
    for (const entry of value instanceof Map ? value.entries() : value.values()) {
      const size = JSON.stringify(entry, processingReplacer).length;
      if (value instanceof Map && size > 128 * 1024 && (entry[0] === null || ['string', 'number', 'boolean'].includes(typeof entry[0]))) {
        await flush();
        await emitProcessingValue(entry[1], send, [...location, { mapKey: entry[0] }]);
        continue;
      }
      if (size > 4 * 1024 * 1024 - 1024) throw Error('Processing collection entry exceeds its bound');
      if (batch.length && (batch.length >= 64 || length + size > 128 * 1024)) await flush();
      batch.push(entry); length += size;
    }
    await flush();
  } else if (Array.isArray(value)) {
    await send({ type: 'open', path: location, array: true });
    for (let start = 0; start < value.length; start += 64) {
      const batch = value.slice(start, start + 64);
      if (JSON.stringify(batch, processingReplacer).length <= 128 * 1024)
        await send({ type: 'items', path: location, start, items: batch });
      else for (let i = 0; i < batch.length; i++) await emitProcessingValue(batch[i], send, [...location, start + i]);
    }
  } else if (value && typeof value === 'object' && !(value instanceof Map) && !(value instanceof Set)) {
    await send({ type: 'open', path: location, array: false });
    for (const key of Object.keys(value)) await emitProcessingValue(value[key], send, [...location, key]);
  } else throw new Error('Processing scalar exceeds its bound');
}

export async function emitProcessingAssignments(rows, send = emit) {
  if (!Array.isArray(rows)) throw Error("Demand assignments were not requested by the job");
  let batch = [], bytes = 0;
  const flush = async () => { if (batch.length) await send({ type: 'assignments', assignments: batch }); batch = []; bytes = 0; };
  for (const row of rows) {
    const size = JSON.stringify(row, processingReplacer).length;
    if (size > 4 * 1024 * 1024 - 1024) throw Error('Processing assignment exceeds its bound');
    if (batch.length && bytes + size > 128 * 1024) await flush();
    batch.push(row); bytes += size;
  }
  await flush();
}

function diskStore(directory) {
  const filename = key => path.join(directory, key === 'manifest' ? 'manifest.json' : Number.isInteger(key) && key >= 0 && key < 4096 ? key + '.gz' : (() => { throw Error('Invalid cache key'); })());
  return {
    async read(key) { try { const bytes = await readFile(filename(key)); return key === 'manifest' ? JSON.parse(bytes) : bytes; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async write(key, value) { await mkdir(directory, { recursive: true }); await writeFile(filename(key), key === 'manifest' ? JSON.stringify(value) : value); },
    async clear() {
      await mkdir(directory, { recursive: true });
      for (const file of await readdir(directory)) if (/^(manifest\.json|\d+\.gz)$/.test(file)) await rm(path.join(directory, file));
    },
  };
}

async function main() {
  const [directory, cacheRoot] = process.argv.slice(2);
  if (!directory || !cacheRoot) throw Error('Expected scoped processing directories');
  const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'), processingReviver);
  if (request.version !== 'manager-processing-v1') throw Error('Unsupported processing protocol');
  await emit({ type: 'started', version: MANAGER_PROCESSING_HELPER_VERSION, pid: process.pid });
  if (request.kind === 'native-demand') {
    const bytes = await readFile(path.join(directory, 'input.bin'));
    const value = await runNativeDemandWorkerJob({ ...request, bytes }, {
      store: diskStore(path.join(cacheRoot, 'native')),
      emitAssignments: assignments => emitProcessingAssignments(assignments),
      resetAssignments: () => emit({ type: 'reset-assignments' }),
    });
    await emitProcessingValue(value);
  } else if (request.kind === 'cross-mode-share') {
    const replies = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let replyResolve;
    const pendingReplies = [];
    replies.on('line', text => {
      if (text.length > 4 * 1024 * 1024) throw Error('Fare reply exceeds its bound');
      const value = JSON.parse(text, processingReviver);
      if (replyResolve) { const resolve = replyResolve; replyResolve = null; resolve(value); }
      else { if (pendingReplies.length >= 1) throw Error('Unexpected fare reply'); pendingReplies.push(value); }
    });
    const nextReply = () => pendingReplies.length ? Promise.resolve(pendingReplies.shift()) : new Promise(resolve => { replyResolve = resolve; });
    let result, failure, fares;
    const handle = createCrossModeShareWorkerHandler(message => {
      if (message.type === 'fare-requests') fares = message;
      else if (!message.ok) failure = Error(message.error?.message ?? 'Cross-demand calculation failed');
      else result = message.value;
    });
    const input = request.inputFile ? JSON.parse(await readFile(path.join(directory, 'input.bin'), 'utf8'), processingReviver) : request.input;
    handle({ id: 1, type: 'evaluate', input, quoteFares: request.quoteFares });
    if (fares) {
      const quotes = [];
      for (let start = 0; start < fares.requests.length; start += 64) {
        const sequence = start / 64;
        await emit({ type: 'fare-requests', sequence, stations: fares.stations, requests: fares.requests.slice(start, start + 64) });
        const reply = await nextReply();
        if (reply.sequence !== sequence || !Array.isArray(reply.quotes) || reply.quotes.length !== Math.min(64, fares.requests.length - start))
          throw Error('Unexpected fare reply');
        quotes.push(...reply.quotes);
      }
      handle({ id: 1, type: 'fare-quotes', quotes });
    }
    replies.close();
    if (failure) throw failure;
    if (!result) throw Error('Cross-demand helper returned no result');
    await emitProcessingValue(result);
  } else throw Error('Unsupported processing job');
  await emit({ type: 'complete', version: MANAGER_PROCESSING_HELPER_VERSION });
}

if (process.argv[1]?.endsWith('manager-processing.cjs') || process.argv[1]?.endsWith('manager-processing-helper.mjs')) {
  main().catch(async error => {
    try { await emit({ type: 'error', message: error.message }); } catch {}
    process.exitCode = 1;
  });
}

