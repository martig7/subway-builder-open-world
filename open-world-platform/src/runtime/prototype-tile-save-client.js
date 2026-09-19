// Experimental transport. The caller must hold a stable native snapshot until
// upload completes. No native save API, catalog or existing file is replaced.
export const TILE_SAVE_PROTOTYPE_VERSION = 'tile-save-prototype-v1';
export const TILE_SAVE_ENCODER_VERSION = 'tile-save-encoder-v2';

/**
 * Prototype uploads omit the native journey-history rows (`c`) from the
 * demand blob. The game's loader treats a missing `c` as an empty history
 * and its save schema marks the blob optional, while the demand model (`p`),
 * rail topology and train inventory stream untouched. History (fare stats and
 * journey origins) resets on the copy the server publishes; the live game and
 * native saves are never modified.
 */
export function slimExperimentalSaveDemand(save) {
  const blob = save?.data?.compressedDemandData;
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.c) || blob.c.length === 0)
    return { save, omittedJourneyRows: 0 };
  return {
    save: { ...save, data: { ...save.data, compressedDemandData: { ...blob, c: [] } } },
    omittedJourneyRows: blob.c.length,
  };
}

const jsonValue = (value, key) => value && typeof value.toJSON === 'function' ? value.toJSON(key) : value;
function* jsonTextChunks(value, chunkCharacters) {
  const ancestors = new Set();
  let parts = [], length = 0;
  const append = text => {
    if (text.length > 1024 * 1024) throw new Error('Prototype save contains an unsupported large scalar');
    parts.push(text); length += text.length;
    return length >= chunkCharacters;
  };
  const flush = () => { const text = parts.join(''); parts = []; length = 0; return text; };
  function* visit(value) {
    if (ancestors.has(value)) throw new TypeError('Circular save data');
    ancestors.add(value);
    try {
      const array = Array.isArray(value);
      if (append(array ? '[' : '{')) yield flush();
      let first = true;
      // Buffer scalar tokens here instead of yielding each punctuation mark
      // through every ancestor generator. Only complete chunks cross the tree.
      for (const key of array ? Array.prototype.keys.call(value) : Object.keys(value)) {
        const item = jsonValue(value[key], String(key));
        const omitted = item === undefined || typeof item === 'function' || typeof item === 'symbol';
        if (!array && omitted) continue;
        if (!first && append(',')) yield flush();
        first = false;
        if (!array) {
          if (append(JSON.stringify(key))) yield flush();
          if (append(':')) yield flush();
        }
        if (item !== null && typeof item === 'object') yield* visit(item);
        else if (append(omitted ? 'null' : JSON.stringify(item))) yield flush();
      }
      if (append(array ? ']' : '}')) yield flush();
    } finally { ancestors.delete(value); }
  }
  if (value !== null && typeof value === 'object') yield* visit(value);
  else {
    const text = JSON.stringify(value);
    if (text !== undefined) append(text);
  }
  if (length) yield flush();
}

/** Bounded UTF-8 chunks; shared objects retain native JSON value semantics.
 * Yield between chunks so encoding cannot monopolize the renderer thread. */
export async function* nativeSaveJsonChunks(save, { chunkCharacters = 128 * 1024,
  yieldTask = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0)), onSlice = () => {} } = {}) {
  const encoder = new TextEncoder();
  let started = performance.now();
  for (const text of jsonTextChunks(jsonValue(save, ''), chunkCharacters)) {
    const bytes = encoder.encode(text);
    onSlice(performance.now() - started);
    yield bytes; await yieldTask(); started = performance.now();
  }
}

// Preserve encoder yield frequency while amortizing HTTP/checksum overhead.
// Even an unusually large scalar stays below the server's 4 MiB request cap.
async function* uploadChunks(chunks) {
  let parts = [], size = 0;
  const flush = () => {
    if (parts.length === 1) { const bytes = parts[0]; parts = []; size = 0; return bytes; }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    parts = []; size = 0; return bytes;
  };
  for await (const bytes of chunks) {
    if (size && size + bytes.length > 4 * 1024 * 1024) yield flush();
    parts.push(bytes); size += bytes.length;
    if (size >= 512 * 1024) yield flush();
  }
  if (size) yield flush();
}

export async function writePrototypeNativeSave(save, { origin, token, fetchFn = fetch, signal,
  onProgress = () => {}, beforeCommit = () => {}, yieldTask } = {}) {
  const base = new URL('/_prototype/save/', origin);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Save writer must be on loopback');
  // A null token rides the server's game-origin path, which survives server
  // restarts. Explicit tokens keep working for diagnostic control sessions.
  const headers = token ? { 'X-PMTiles-Control-Token': token } : {};
  const stats = { version: TILE_SAVE_PROTOTYPE_VERSION, encoderVersion: TILE_SAVE_ENCODER_VERSION, chunks: 0, bytes: 0, maxEncodeSliceMs: 0, encodeMs: 0, transferMs: 0, startedAt: Date.now() };
  const progress = phase => onProgress({ ...stats, phase });
  async function request(path, body, extra = {}) {
    const started = performance.now();
    const response = await fetchFn(new URL(path, base), { method: 'POST', headers: { ...headers, ...extra }, body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Tile save ${path.split('/').at(-1)} failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
    const result = await response.json(); stats.transferMs += performance.now() - started; return result;
  }
  progress('connecting');
  const begin = await request('begin', JSON.stringify({ name: save.name, cityCode: save.cityCode,
    gameSessionId: save.gameSessionId, timestamp: save.timestamp, version: save.version, metadata: save.metadata }),
  { 'Content-Type': 'application/json' });
  try {
    progress('uploading');
    for await (const bytes of uploadChunks(nativeSaveJsonChunks(save, { yieldTask,
      onSlice: ms => { stats.maxEncodeSliceMs = Math.max(stats.maxEncodeSliceMs, ms); stats.encodeMs += ms; } }))) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      await request(`${begin.id}/chunk/${stats.chunks}`, bytes, { 'Content-Type': 'application/octet-stream', 'X-Save-Chunk-Sha256': hash });
      stats.chunks++; stats.bytes += bytes.byteLength; progress('uploading');
    }
    await beforeCommit();
    progress('finalizing');
    let result;
    try {
      result = await request(`${begin.id}/commit`, JSON.stringify({ chunks: stats.chunks, bytes: stats.bytes }), { 'Content-Type': 'application/json' });
    } catch (error) {
      // A lost commit response must not turn a successful save into a failure.
      const receipt = await fetchFn(new URL(`${begin.id}/result`, base), { method: 'POST', headers, signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!receipt?.ok) { error.saveOutcome = 'unknown'; throw error; }
      try { result = await receipt.json(); }
      catch { error.saveOutcome = 'unknown'; throw error; }
      if (result?.chunks !== stats.chunks || result?.bytes !== stats.bytes) { error.saveOutcome = 'unknown'; throw error; }
    }
    return { ...stats, ...result, durationMs: Date.now() - stats.startedAt };
  } catch (error) {
    // Discard an unfinished upload. After commit, the receipt can be unknown;
    // abort cannot undo an already published save.
    await fetchFn(new URL(`${begin.id}/abort`, base), { method: 'POST', headers,
      signal: AbortSignal.timeout(3000) }).catch(() => {});
    throw error;
  }
}
