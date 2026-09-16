// Experimental transport. The caller must hold a stable native snapshot until
// upload completes. No native save API, catalog or existing file is replaced.
export const TILE_SAVE_PROTOTYPE_VERSION = 'tile-save-prototype-v1';

const jsonValue = (value, key) => value && typeof value.toJSON === 'function' ? value.toJSON(key) : value;
function* jsonTokens(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 1024 * 1024) throw new Error('Prototype save contains an unsupported large scalar');
    const text = JSON.stringify(value);
    if (text !== undefined) yield text;
    return;
  }
  if (ancestors.has(value)) throw new TypeError('Circular save data');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let i = 0; i < value.length; i++) {
        if (i) yield ',';
        const item = jsonValue(value[i], String(i));
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') yield 'null';
        else yield* jsonTokens(item, ancestors);
      }
      yield ']';
    } else {
      yield '{'; let first = true;
      for (const key of Object.keys(value)) {
        const item = jsonValue(value[key], key);
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!first) yield ',';
        first = false; yield JSON.stringify(key); yield ':';
        yield* jsonTokens(item, ancestors);
      }
      yield '}';
    }
  } finally { ancestors.delete(value); }
}

/** Bounded UTF-8 chunks; shared objects retain native JSON value semantics.
 * Yield between chunks so encoding cannot monopolize the renderer thread. */
export async function* nativeSaveJsonChunks(save, { chunkCharacters = 128 * 1024,
  yieldTask = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0)), onSlice = () => {} } = {}) {
  const encoder = new TextEncoder();
  let parts = [], length = 0, started = performance.now();
  for (const token of jsonTokens(jsonValue(save, ''))) {
    if (token.length > 1024 * 1024) throw new Error('Prototype save contains an unsupported large scalar');
    parts.push(token); length += token.length;
    if (length >= chunkCharacters) {
      const bytes = encoder.encode(parts.join('')); parts = []; length = 0;
      onSlice(performance.now() - started);
      yield bytes; await yieldTask(); started = performance.now();
    }
  }
  if (length) { const bytes = encoder.encode(parts.join('')); onSlice(performance.now() - started); yield bytes; }
}

export async function writePrototypeNativeSave(save, { origin, token, fetchFn = fetch, signal,
  onProgress = () => {}, beforeCommit = () => {}, yieldTask } = {}) {
  const base = new URL('/_prototype/save/', origin);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Save writer must be on loopback');
  // A null token rides the server's game-origin path, which survives server
  // restarts. Explicit tokens keep working for diagnostic control sessions.
  const headers = token ? { 'X-PMTiles-Control-Token': token } : {};
  const stats = { version: TILE_SAVE_PROTOTYPE_VERSION, chunks: 0, bytes: 0, maxEncodeSliceMs: 0, encodeMs: 0, transferMs: 0, startedAt: Date.now() };
  async function request(path, body, extra = {}) {
    const started = performance.now();
    const response = await fetchFn(new URL(path, base), { method: 'POST', headers: { ...headers, ...extra }, body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Tile save ${path.split('/').at(-1)} failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
    const result = await response.json(); stats.transferMs += performance.now() - started; return result;
  }
  const begin = await request('begin', JSON.stringify({ name: save.name, cityCode: save.cityCode,
    gameSessionId: save.gameSessionId, timestamp: save.timestamp, version: save.version, metadata: save.metadata }),
  { 'Content-Type': 'application/json' });
  try {
    for await (const bytes of nativeSaveJsonChunks(save, { yieldTask,
      onSlice: ms => { stats.maxEncodeSliceMs = Math.max(stats.maxEncodeSliceMs, ms); stats.encodeMs += ms; } })) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      await request(`${begin.id}/chunk/${stats.chunks}`, bytes, { 'Content-Type': 'application/octet-stream', 'X-Save-Chunk-Sha256': hash });
      stats.chunks++; stats.bytes += bytes.byteLength; onProgress({ ...stats });
    }
    await beforeCommit();
    let result;
    try {
      result = await request(`${begin.id}/commit`, JSON.stringify({ chunks: stats.chunks, bytes: stats.bytes }), { 'Content-Type': 'application/json' });
    } catch (error) {
      // A lost commit response must not turn a successful save into a failure.
      const receipt = await fetchFn(new URL(`${begin.id}/result`, base), { method: 'POST', headers, signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!receipt?.ok) throw error;
      result = await receipt.json();
      if (result.chunks !== stats.chunks || result.bytes !== stats.bytes) throw error;
    }
    return { ...stats, ...result, durationMs: Date.now() - stats.startedAt };
  } catch (error) {
    // A failed/cancelled transfer never publishes its partial file.
    await fetchFn(new URL(`${begin.id}/abort`, base), { method: 'POST', headers,
      signal: AbortSignal.timeout(3000) }).catch(() => {});
    throw error;
  }
}
