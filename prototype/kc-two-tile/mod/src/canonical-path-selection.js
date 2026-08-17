const PATH_INDEX_KEY = 'identity:canonical-path-options';
const SELECTION_PREFIX = 'identity:canonical-path-selection:';
const SCHEMA_VERSION = 1;

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePath(path) {
  const id = normalizeText(path?.id);
  const label = normalizeText(path?.label);
  if (!id || !label) return null;
  const worldId = path?.worldId == null ? null : normalizeText(path.worldId);
  const rawDescription = normalizeText(path?.description) ?? '';
  // Older user-created entries predate the explicit flag. Preserve them by
  // recognizing their stable generated id/description during normalization.
  const userSaved = path?.userSaved === true
    || worldId?.startsWith('ny-lineage:')
    || /^User-saved (canonical lineage|world)\.?$/i.test(rawDescription);
  const description = userSaved && /^User-saved canonical lineage\.?$/i.test(rawDescription)
    ? 'User-saved world.'
    : rawDescription;
  return Object.freeze({
    id,
    label,
    description,
    worldId,
    nativeSession: path?.nativeSession === true,
    userSaved,
    day: normalizeNumber(path?.day),
    worldTime: normalizeNumber(path?.worldTime),
    routeCount: normalizeNumber(path?.routeCount),
    stationCount: normalizeNumber(path?.stationCount),
    trainCount: normalizeNumber(path?.trainCount),
    elapsedSeconds: normalizeNumber(path?.elapsedSeconds),
    wallet: normalizeNumber(path?.wallet ?? path?.money),
    money: normalizeNumber(path?.money ?? path?.wallet),
    fare: normalizeNumber(path?.fare),
    savedAt: normalizeNumber(path?.savedAt),
  });
}

function encoded(value) {
  return encodeURIComponent(String(value ?? ''));
}

function selectionKey(nativeSessionId, saveName = null) {
  const session = encoded(nativeSessionId);
  return saveName
    ? `${SELECTION_PREFIX}${session}:save:${encoded(saveName)}`
    : `${SELECTION_PREFIX}${session}`;
}

function validSessionId(value) {
  return normalizeText(value);
}

/**
 * User-controlled canonical-path selection at the save-identity seam.
 *
 * The module deliberately has no fallback choice. Callers either receive a
 * persisted selection or wait for choose(). The native-session option is
 * resolved to the current native session only when selected explicitly.
 */
export class CanonicalPathSelection {
  constructor({ storage = new Map(), paths = [] } = {}) {
    this.storage = storage;
    this.configuredPaths = new Map(
      paths.map(normalizePath).filter(Boolean).map((path) => [path.id, path]),
    );
    this.paths = new Map(this.configuredPaths);
    this.selections = new Map();
    this.waiters = new Set();
    this.listeners = new Set();
    this.initialized = false;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* UI observers are advisory. */ }
    }
  }

  async initialize() {
    if (this.initialized) return this.listPaths();
    const stored = await this.storage?.get?.(PATH_INDEX_KEY, null);
    for (const path of Array.isArray(stored?.paths) ? stored.paths : []) {
      const normalized = normalizePath(path);
      if (normalized) this.paths.set(normalized.id, normalized);
    }
    await this.#persistPaths();
    this.initialized = true;
    this.#emit();
    return this.listPaths();
  }

  listPaths() {
    return [...this.paths.values()].map((path) => clone(path));
  }

  path(pathId) {
    return clone(this.paths.get(pathId) ?? null);
  }

  async registerPath(path) {
    const existing = this.paths.get(path?.id);
    const normalized = normalizePath({ ...existing, ...path });
    if (!normalized) throw new Error('Canonical path requires an id and label');
    this.paths.set(normalized.id, normalized);
    await this.#persistPaths();
    this.#emit();
    return clone(normalized);
  }

  async updateMetadata(pathId, metadata = {}) {
    const path = this.paths.get(pathId);
    if (!path) return null;
    return this.registerPath({ ...path, ...metadata });
  }

  async #persistPaths() {
    await this.storage?.set?.(PATH_INDEX_KEY, {
      schemaVersion: SCHEMA_VERSION,
      paths: this.listPaths(),
    });
  }

  async #readSelection(nativeSessionId, saveName = null) {
    const session = validSessionId(nativeSessionId);
    if (!session) return null;
    const exact = saveName
      ? await this.storage?.get?.(selectionKey(session, saveName), null)
      : null;
    const value = exact ?? await this.storage?.get?.(selectionKey(session), null);
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !this.paths.has(value.pathId)) return null;
    return clone({
      ...value,
      path: this.paths.get(value.pathId),
      worldId: this.resolveWorldId(this.paths.get(value.pathId), session),
    });
  }

  async selectionFor({ nativeSessionId = null, saveName = null } = {}) {
    const session = validSessionId(nativeSessionId);
    if (!session) return null;
    const cacheKey = `${session}\u0000${saveName ?? ''}`;
    if (this.selections.has(cacheKey)) return clone(this.selections.get(cacheKey));
    const selection = await this.#readSelection(session, saveName);
    if (selection) this.selections.set(cacheKey, selection);
    return clone(selection);
  }

  resolveWorldId(path, nativeSessionId) {
    if (!path) return null;
    return path.nativeSession || path.worldId == null
      ? validSessionId(nativeSessionId)
      : path.worldId;
  }

  async choose({ nativeSessionId = null, saveName = null, pathId } = {}) {
    const session = validSessionId(nativeSessionId);
    const path = this.paths.get(pathId);
    if (!session) throw new Error('Cannot select a canonical path without a native session id');
    if (!path) throw new Error(`Unknown canonical path: ${pathId}`);
    const selection = {
      schemaVersion: SCHEMA_VERSION,
      pathId: path.id,
      nativeSessionId: session,
      saveName: saveName ?? null,
      selectedAt: Date.now(),
    };
    await this.storage?.set?.(selectionKey(session), selection);
    if (saveName) await this.storage?.set?.(selectionKey(session, saveName), selection);
    const resolved = {
      ...selection,
      path: clone(path),
      worldId: this.resolveWorldId(path, session),
    };
    this.selections.set(`${session}\u0000${saveName ?? ''}`, resolved);
    this.selections.set(`${session}\u0000`, resolved);
    for (const waiter of [...this.waiters]) {
      if (waiter.nativeSessionId !== session) continue;
      if (waiter.saveName && saveName && waiter.saveName !== saveName) continue;
      this.waiters.delete(waiter);
      waiter.resolve(clone(resolved));
    }
    this.#emit();
    return clone(resolved);
  }

  async waitForSelection({ nativeSessionId = null, saveName = null } = {}) {
    const existing = await this.selectionFor({ nativeSessionId, saveName });
    if (existing) return existing;
    const session = validSessionId(nativeSessionId);
    if (!session) throw new Error('Cannot select a canonical path without a native session id');
    return new Promise((resolve, reject) => {
      this.waiters.add({ nativeSessionId: session, saveName: saveName ?? null, resolve, reject });
      this.#emit();
    });
  }

  cancel(reason = 'Canonical path selection cancelled') {
    const error = new Error(reason);
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  snapshot({ nativeSessionId = null, saveName = null, canSave = false } = {}) {
    const session = validSessionId(nativeSessionId);
    const cacheKey = `${session ?? ''}\u0000${saveName ?? ''}`;
    return {
      nativeSessionId: session,
      saveName: saveName ?? null,
      canSave: canSave === true,
      paths: this.listPaths(),
      selection: clone(this.selections.get(cacheKey) ?? this.selections.get(`${session ?? ''}\u0000`) ?? null),
      waiting: [...this.waiters].some((waiter) => waiter.nativeSessionId === session),
    };
  }
}

export const CANONICAL_PATH_SELECTION_INDEX_KEY = PATH_INDEX_KEY;
export const CANONICAL_PATH_SELECTION_PREFIX = SELECTION_PREFIX;
