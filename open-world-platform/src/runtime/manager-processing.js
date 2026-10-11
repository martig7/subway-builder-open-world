import { nativeSaveJsonChunks } from './prototype-tile-save-client.js';

export const MANAGER_PROCESSING_VERSION = 'manager-processing-v1';
const disabled = Object.freeze({ version: MANAGER_PROCESSING_VERSION, demandEnabled: false, savesEnabled: false, stationNamingEnabled: false, supported: false });
const replacer = (_, value) => value instanceof Map ? { __openWorldType: 'Map', entries: [...value] }
  : value instanceof Set ? { __openWorldType: 'Set', entries: [...value] } : value;
const reviver = (_, value) => value?.__openWorldType === 'Map' && Array.isArray(value.entries) ? new Map(value.entries)
  : value?.__openWorldType === 'Set' && Array.isArray(value.entries) ? new Set(value.entries) : value;

function mapKey(key) {
  return key !== null && typeof key === 'object' && Object.keys(key).length === 1 && Object.hasOwn(key, 'mapKey')
    && (key.mapKey === null || ['string', 'number', 'boolean'].includes(typeof key.mapKey));
}
function child(parent, key) {
  if (mapKey(key)) {
    if (!(parent instanceof Map)) throw Error('Invalid processing map path');
    return parent.get(key.mapKey);
  }
  if (!['string', 'number'].includes(typeof key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Invalid processing result path');
  return parent?.[key];
}
function assign(result, location, value) {
  if (!location.length) return value;
  let parent = result;
  for (const key of location.slice(0, -1)) {
    parent = child(parent, key);
  }
  const key = location.at(-1);
  if (!parent) throw Error('Invalid processing result path');
  if (mapKey(key)) {
    if (!(parent instanceof Map)) throw Error('Invalid processing map path');
    parent.set(key.mapKey, value);
  } else { child(parent, key); parent[key] = value; }
  return result;
}

export async function readManagerDemandResponse(response, { onAssignments = () => {}, onReset = () => {}, quoteFares = null, reply = async () => {} } = {}) {
  if (!response.body?.getReader) throw Error('Manager demand streaming is unavailable');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', result, complete = false, total = 0;
  const message = async data => {
    if (complete) throw Error('Unexpected processing data after completion');
    if (data.type === 'error') throw Error(data.message ?? 'Manager demand calculation failed');
    if (data.type === 'assignments') { onAssignments(data.assignments); return; }
    if (data.type === 'reset-assignments') { onReset(); return; }
    if (data.type === 'open') result = assign(result, data.path, data.collection === 'Map' ? new Map() : data.collection === 'Set' ? new Set() : data.array ? [] : {});
    else if (data.type === 'value') result = assign(result, data.path, data.value);
    else if (data.type === 'items') {
      let target = result;
      for (const key of data.path) {
        target = child(target, key);
      }
      if (!Array.isArray(target) || !Number.isSafeInteger(data.start) || data.start < 0) throw Error('Invalid processing array');
      data.items.forEach((value, index) => { target[data.start + index] = value; });
    } else if (data.type === 'entries') {
      let target = result;
      for (const key of data.path) {
        target = child(target, key);
      }
      if (!(target instanceof Map || target instanceof Set) || !Array.isArray(data.entries)) throw Error('Invalid processing collection');
      for (const entry of data.entries) {
        if (target instanceof Map) {
          if (!Array.isArray(entry) || entry.length !== 2) throw Error('Invalid processing map entry');
          target.set(entry[0], entry[1]);
        } else target.add(entry);
      }
    } else if (data.type === 'fare-requests') {
      if (!quoteFares) throw Error('The manager requested unavailable native fare quotes');
      const stations = new Map(data.stations);
      const quotes = data.requests.map(({ key, stationRoutes }) => {
        const quote = quoteFares(stationRoutes, stations);
        return [key, { total: quote?.total, revenueByRoute: quote?.revenueByRoute }];
      });
      await reply({ sequence: data.sequence, quotes });
    } else if (data.type === 'complete') {
      if (data.version !== 'manager-processing-helper-v1' || result == null) throw Error('Incomplete manager demand result');
      complete = true;
    } else if (data.type !== 'started') throw Error('Unknown manager processing response');
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 512 * 1024 * 1024) throw Error('Manager demand response exceeds its bound');
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 4 * 1024 * 1024) throw Error('Manager demand message exceeds its bound');
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line) await message(JSON.parse(line, reviver));
      }
      if (pending.length > 4 * 1024 * 1024) throw Error('Manager demand message exceeds its bound');
    }
    pending += decoder.decode();
    if (pending.trim() || !complete) throw Error('Manager demand response ended before completion');
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Offloading is chosen before allocating the local worker. Selected failures
 * never fall back to a heavy renderer calculation. */
export function createManagerProcessing({ baseUrl, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('Manager processing requires the local tile server');
  let last = disabled, checkedAt = -Infinity, pendingSettings = null, disposed = false;
  const active = new Set();
  const settings = async ({ fresh = false } = {}) => {
    if (disposed) throw Error('Manager processing was disposed');
    if (!fresh && now() - checkedAt < 1000) return last;
    if (pendingSettings) return pendingSettings;
    pendingSettings = (async () => {
      try {
        const response = await fetchFn(new URL('/_processing/settings', base), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (response.ok) {
          const value = await response.json();
          if (value?.version !== MANAGER_PROCESSING_VERSION || ['demandEnabled', 'savesEnabled', 'stationNamingEnabled'].some(key => typeof value[key] !== 'boolean'))
            throw Error('Manager processing version differs');
          last = { ...value, supported: true };
        } else if (response.status === 404 && !last.supported) last = disabled;
        else throw Error('Manager settings are unavailable');
      } catch (error) {
        // Retain an explicit choice while the selected backend is unavailable.
        // In particular, a lost server cannot silently enable native saving.
        if (last.supported) last = { ...last, error: error.message };
      }
      checkedAt = now(); return last;
    })().finally(() => { pendingSettings = null; });
    return pendingSettings;
  };
  async function request(route, body, { signal, binary = false } = {}) {
    if (disposed) throw Error('Manager processing was disposed');
    const response = await fetchFn(new URL(route, base), { method: 'POST', headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? body : JSON.stringify(body, replacer), signal });
    if (!response.ok) throw Error('Manager processing failed (' + response.status + '): ' + (await response.text()).slice(0, 160));
    return response;
  }
  async function run(metadata, bytes, { onAssignments, onReset, quoteFares } = {}) {
    const abort = new AbortController(); active.add(abort);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300000)]);
    let id;
    try {
      const begin = await request('/_processing/demand/begin', { version: MANAGER_PROCESSING_VERSION, ...metadata }, { signal });
      id = (await begin.json()).id;
      if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid manager job identity');
      let sequence = 0;
      const source = metadata.packagedTileId ? null : typeof bytes === 'function' ? await bytes() : bytes;
      if (source?.[Symbol.asyncIterator]) {
        for await (const chunk of source) {
          if (chunk.byteLength > 1024 * 1024) throw Error('Manager demand input chunk exceeds its bound');
          await request('/_processing/demand/' + id + '/chunk/' + sequence++, chunk, { signal, binary: true });
        }
      } else if (source) {
        const data = source instanceof Uint8Array ? source : new Uint8Array(source);
        for (let start = 0; start < data.length; start += 512 * 1024)
          await request('/_processing/demand/' + id + '/chunk/' + sequence++, data.subarray(start, start + 512 * 1024), { signal, binary: true });
      }
      const response = await request('/_processing/demand/' + id + '/run', {}, { signal });
      return await readManagerDemandResponse(response, { onAssignments, onReset, quoteFares,
        reply: async value => { await request('/_processing/demand/' + id + '/reply', value, { signal }); } });
    } finally {
      active.delete(abort);
      abort.abort();
      if (id) await fetchFn(new URL('/_processing/demand/' + id + '/abort', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
  }
  return {
    origin: base.origin,
    settings, request: async (route, value, options) => (await request(route, value, options)).json(),
    snapshot: () => ({ ...last, activeJobs: active.size, version: MANAGER_PROCESSING_VERSION }),
    async evaluateNative(bytes, input, { gzip = false, cacheMode = input.includeAssignments ? 'assignments' : null, packagedTileId = null } = {}) {
      const assignments = [];
      const result = await run({ kind: 'native-demand', input, gzip, cacheMode, ...(packagedTileId ? { packagedTileId } : {}) }, bytes, {
        onAssignments: batch => { for (const row of batch) assignments.push(row); }, onReset: () => { assignments.length = 0; },
      });
      return cacheMode === 'assignments' ? { ...result, assignments, processing: 'manager' } : { ...result, processing: 'manager' };
    },
    async evaluateCross(input) {
      const { journeyFare, tileCatalog, ...compact } = input;
      if (tileCatalog) compact.tileCatalog = { tiles: (tileCatalog.tiles ?? []).map(tile => ({
        id: tile.id, bounds: tile.bounds, neighbors: (tile.neighbors ?? []).map(neighbor => ({ tileId: neighbor.tileId })),
      })) };
      return run({ kind: 'cross-mode-share', inputFile: true, quoteFares: typeof journeyFare === 'function' },
        () => nativeSaveJsonChunks(compact, { replacer }), { quoteFares: journeyFare });
    },
    streamJson: value => nativeSaveJsonChunks(value),
    dispose() { disposed = true; for (const job of active) job.abort(); active.clear(); },
  };
}

