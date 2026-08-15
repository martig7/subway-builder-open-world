// PROTOTYPE: pure 35-tile state model. No DOM, storage, or Subway Builder calls.

export const CHECKPOINT_LIMIT = 10;

function copy(value) { return structuredClone(value); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}

function addEvent(state, message, kind = 'info') {
  state.events.push({ sequence: state.metrics.actions, kind, message });
  if (state.events.length > 60) state.events.splice(0, state.events.length - 60);
  state.lastEvent = message;
}

function storeBlob(state, kind, payload) {
  const value = { kind, payload: copy(payload) };
  const hash = contentHash(value);
  state.blobs[hash] ??= value;
  return hash;
}

function readBlob(state, hash, kind) {
  const value = state.blobs[hash];
  if (!value || value.kind !== kind) throw new Error(`Missing ${kind} blob: ${hash}`);
  return copy(value.payload);
}

function snapshotActiveTile(state) {
  const tile = state.tiles[state.activeTileId];
  const payload = {
    tileId: state.activeTileId,
    revision: tile.revision,
    localObjects: state.activeLocalObjects,
  };
  tile.snapshotHash = storeBlob(state, 'tile-snapshot', payload);
  tile.localObjectCount = state.activeLocalObjects.length;
  state.metrics.snapshotWrites += 1;
  return tile.snapshotHash;
}

function storeGlobalNetwork(state) {
  state.globalNetworkHash = storeBlob(state, 'global-network', state.globalNetwork);
  return state.globalNetworkHash;
}

function referencedBlobHashes(state) {
  const references = new Set();
  for (const tile of Object.values(state.tiles)) if (tile.snapshotHash) references.add(tile.snapshotHash);
  if (state.globalNetworkHash) references.add(state.globalNetworkHash);
  for (const entry of state.checkpoints.entries) {
    if (entry.globalNetworkHash) references.add(entry.globalNetworkHash);
    for (const hash of Object.values(entry.tileSnapshotHashByTile)) if (hash) references.add(hash);
  }
  return references;
}

function collectGarbage(state) {
  const references = referencedBlobHashes(state);
  let deleted = 0;
  for (const hash of Object.keys(state.blobs)) {
    if (!references.has(hash)) {
      delete state.blobs[hash];
      deleted += 1;
    }
  }
  state.metrics.garbageCollectedBlobs += deleted;
  return deleted;
}

function initialTileState() {
  return { revision: 0, lastSimulatedDay: 0, snapshotHash: null, localObjectCount: 0 };
}

export function createRuntimeModel(catalog, {
  worldId = 'ny-state-runtime-fixture',
  wallet = 1_000_000,
} = {}) {
  const normalTiles = catalog.tiles.filter((tile) => tile.status === 'normal');
  const tileIds = normalTiles.map((tile) => tile.id);
  const activeTileId = normalTiles.find((tile) => tile.isNycBaseTile)?.id ?? tileIds[0];
  if (tileIds.length !== 33) throw new Error(`Expected 33 normal tiles, got ${tileIds.length}`);
  const state = {
    schemaVersion: 1,
    worldId,
    tileIds,
    sliverTileIds: catalog.tiles.filter((tile) => tile.status === 'sliver').map((tile) => tile.id),
    activeTileId,
    worldDay: 0,
    wallet,
    revision: 0,
    tiles: Object.fromEntries(tileIds.map((tileId) => [tileId, initialTileState()])),
    activeLocalObjects: [],
    globalNetwork: { revision: 0, objects: [] },
    globalNetworkHash: null,
    blobs: {},
    checkpoints: { nextSequence: 0, entries: [] },
    pendingTransition: null,
    metrics: {
      actions: 0,
      transitions: 0,
      rejectedActions: 0,
      snapshotWrites: 0,
      garbageCollectedBlobs: 0,
      maxTransitionTouchedTiles: 0,
      maxDeserializedTiles: 0,
      lastTouchedTileIds: [],
      lastDeserializedTileIds: [],
    },
    events: [],
    lastEvent: 'World created at the NYC base tile.',
    soakReport: null,
  };
  storeGlobalNetwork(state);
  snapshotActiveTile(state);
  addEvent(state, state.lastEvent);
  return assertRuntimeModel(state);
}

function reject(state, message) {
  state.metrics.rejectedActions += 1;
  state.metrics.lastTouchedTileIds = [];
  state.metrics.lastDeserializedTileIds = [];
  addEvent(state, message, 'error');
}

function switchTile(state, tileId) {
  if (!state.tileIds.includes(tileId)) return reject(state, `Switch rejected: ${tileId} is not a playable tile.`);
  if (tileId === state.activeTileId) return addEvent(state, `${tileId} is already active.`, 'neutral');
  const sourceId = state.activeTileId;
  state.pendingTransition = { from: sourceId, to: tileId, phase: 'snapshot' };
  snapshotActiveTile(state);
  state.pendingTransition.phase = 'load';
  const destination = state.tiles[tileId];
  state.activeLocalObjects = destination.snapshotHash
    ? readBlob(state, destination.snapshotHash, 'tile-snapshot').localObjects
    : [];
  state.pendingTransition.phase = 'commit';
  state.tiles[sourceId].revision += 1;
  destination.revision += 1;
  destination.lastSimulatedDay = state.worldDay;
  state.activeTileId = tileId;
  state.revision += 1;
  state.metrics.transitions += 1;
  state.metrics.lastTouchedTileIds = [sourceId, tileId];
  state.metrics.lastDeserializedTileIds = [tileId];
  state.metrics.maxTransitionTouchedTiles = Math.max(state.metrics.maxTransitionTouchedTiles, 2);
  state.metrics.maxDeserializedTiles = Math.max(state.metrics.maxDeserializedTiles, 1);
  state.pendingTransition = null;
  addEvent(state, `Switched ${sourceId} → ${tileId}; the global network stayed at revision ${state.globalNetwork.revision}.`);
}

function buildNetworkObject(state, objectKind = 'track') {
  const object = {
    id: `${objectKind}-${String(state.globalNetwork.objects.length + 1).padStart(4, '0')}`,
    kind: objectKind,
    ownerTileId: state.activeTileId,
    createdRevision: state.revision + 1,
  };
  state.globalNetwork.objects.push(object);
  state.globalNetwork.revision += 1;
  state.revision += 1;
  state.activeLocalObjects.push({ id: `${object.id}:local-marker`, kind: 'network-marker' });
  state.tiles[state.activeTileId].revision += 1;
  storeGlobalNetwork(state);
  state.metrics.lastTouchedTileIds = [state.activeTileId];
  state.metrics.lastDeserializedTileIds = [];
  addEvent(state, `Built ${object.id} in ${state.activeTileId}; it is referenced by the global network.`);
}

function advanceDay(state, days = 1) {
  const amount = Math.max(1, Math.floor(days));
  state.worldDay += amount;
  for (const tile of Object.values(state.tiles)) tile.lastSimulatedDay = state.worldDay;
  state.revision += 1;
  state.metrics.lastTouchedTileIds = [];
  state.metrics.lastDeserializedTileIds = [];
  addEvent(state, `Advanced the compact world simulation to day ${state.worldDay}; no inactive snapshot was loaded.`);
}

function changeWallet(state, delta) {
  if (!Number.isFinite(delta)) return reject(state, 'Wallet change rejected: amount is not finite.');
  state.wallet += delta;
  state.revision += 1;
  state.metrics.lastTouchedTileIds = [];
  state.metrics.lastDeserializedTileIds = [];
  addEvent(state, `World wallet changed by ${delta.toLocaleString('en-US')} to ${state.wallet.toLocaleString('en-US')}.`);
}

function saveCheckpoint(state, saveName) {
  const identity = String(saveName ?? '').trim();
  if (!identity) return reject(state, 'Autosave rejected: an exact save identity is required.');
  snapshotActiveTile(state);
  storeGlobalNetwork(state);
  const sequence = state.checkpoints.nextSequence + 1;
  state.checkpoints.nextSequence = sequence;
  const entry = {
    checkpointId: String(sequence).padStart(10, '0'),
    saveName: identity,
    sequence,
    world: {
      activeTileId: state.activeTileId,
      worldDay: state.worldDay,
      wallet: state.wallet,
      revision: state.revision,
    },
    tileSnapshotHashByTile: Object.fromEntries(state.tileIds.map((tileId) => [tileId, state.tiles[tileId].snapshotHash])),
    tileRevisionByTile: Object.fromEntries(state.tileIds.map((tileId) => [tileId, state.tiles[tileId].revision])),
    globalNetworkHash: state.globalNetworkHash,
  };
  state.checkpoints.entries = state.checkpoints.entries.filter((item) => item.saveName !== identity);
  state.checkpoints.entries.push(entry);
  state.checkpoints.entries.sort((left, right) => left.sequence - right.sequence);
  if (state.checkpoints.entries.length > CHECKPOINT_LIMIT) {
    state.checkpoints.entries.splice(0, state.checkpoints.entries.length - CHECKPOINT_LIMIT);
  }
  const deleted = collectGarbage(state);
  state.metrics.lastTouchedTileIds = [state.activeTileId];
  state.metrics.lastDeserializedTileIds = [];
  addEvent(state, `Saved ${identity} as checkpoint ${entry.checkpointId}; retained ${state.checkpoints.entries.length}, reclaimed ${deleted} blobs.`);
}

function loadCheckpoint(state, saveName) {
  const identity = String(saveName ?? '').trim();
  const entry = [...state.checkpoints.entries].reverse().find((candidate) => candidate.saveName === identity);
  if (!entry) return reject(state, `Load rejected: no retained checkpoint exactly matches “${identity}”.`);
  state.activeTileId = entry.world.activeTileId;
  state.worldDay = entry.world.worldDay;
  state.wallet = entry.world.wallet;
  state.revision = entry.world.revision;
  for (const tileId of state.tileIds) {
    state.tiles[tileId].snapshotHash = entry.tileSnapshotHashByTile[tileId] ?? null;
    state.tiles[tileId].revision = entry.tileRevisionByTile[tileId] ?? 0;
    state.tiles[tileId].lastSimulatedDay = state.worldDay;
  }
  state.globalNetworkHash = entry.globalNetworkHash;
  state.globalNetwork = readBlob(state, entry.globalNetworkHash, 'global-network');
  const activeHash = state.tiles[state.activeTileId].snapshotHash;
  state.activeLocalObjects = activeHash ? readBlob(state, activeHash, 'tile-snapshot').localObjects : [];
  state.pendingTransition = null;
  state.metrics.lastTouchedTileIds = [state.activeTileId];
  state.metrics.lastDeserializedTileIds = [state.activeTileId];
  state.metrics.maxDeserializedTiles = Math.max(state.metrics.maxDeserializedTiles, 1);
  addEvent(state, `Loaded exact checkpoint “${identity}” at day ${state.worldDay}; newer checkpoints were ignored.`);
}

function nextRandom(seed) {
  const value = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  return [value, value / 0x1_0000_0000];
}

function runSoakMutable(state, count = 1_000, seed = 0x5eed1234) {
  const startedTransitions = state.metrics.transitions;
  let currentSeed = seed >>> 0;
  let assertions = 0;
  for (let index = 0; index < count; index += 1) {
    let random;
    [currentSeed, random] = nextRandom(currentSeed);
    const offset = 1 + Math.floor(random * (state.tileIds.length - 1));
    const currentIndex = state.tileIds.indexOf(state.activeTileId);
    const destination = state.tileIds[(currentIndex + offset) % state.tileIds.length];
    switchTile(state, destination);
    if (index % 17 === 0) buildNetworkObject(state, index % 34 === 0 ? 'station' : 'track');
    if (index % 23 === 0) saveCheckpoint(state, `Soak autosave ${String(index).padStart(4, '0')}`);
    if (index > 0 && index % 101 === 0 && state.checkpoints.entries.length) {
      let checkpointRandom;
      [currentSeed, checkpointRandom] = nextRandom(currentSeed);
      const checkpoint = state.checkpoints.entries[Math.floor(checkpointRandom * state.checkpoints.entries.length)];
      loadCheckpoint(state, checkpoint.saveName);
    }
    assertRuntimeModel(state);
    assertions += 1;
  }
  collectGarbage(state);
  state.soakReport = {
    passed: true,
    seed: seed >>> 0,
    requestedTransitions: count,
    completedTransitions: state.metrics.transitions - startedTransitions,
    assertions,
    retainedCheckpoints: state.checkpoints.entries.length,
    blobCount: Object.keys(state.blobs).length,
    networkObjects: state.globalNetwork.objects.length,
    maxTransitionTouchedTiles: state.metrics.maxTransitionTouchedTiles,
    maxDeserializedTiles: state.metrics.maxDeserializedTiles,
  };
  addEvent(state, `Soak passed: ${count.toLocaleString('en-US')} transitions, ${assertions.toLocaleString('en-US')} invariant checks.`);
}

function applyMutable(state, action) {
  state.metrics.actions += 1;
  switch (action.type) {
    case 'SWITCH_TILE': switchTile(state, action.tileId); break;
    case 'BUILD_NETWORK_OBJECT': buildNetworkObject(state, action.objectKind); break;
    case 'ADVANCE_DAY': advanceDay(state, action.days); break;
    case 'CHANGE_WALLET': changeWallet(state, action.delta); break;
    case 'SAVE_CHECKPOINT': saveCheckpoint(state, action.saveName); break;
    case 'LOAD_CHECKPOINT': loadCheckpoint(state, action.saveName); break;
    case 'RUN_SOAK': runSoakMutable(state, action.count, action.seed); break;
    default: reject(state, `Unknown action: ${action.type}`);
  }
  return assertRuntimeModel(state);
}

export function reduceRuntimeModel(state, action) {
  return applyMutable(copy(state), action);
}

export function assertRuntimeModel(state) {
  if (state.schemaVersion !== 1) throw new Error('Unsupported runtime model schema');
  if (state.tileIds.length !== 33 || new Set(state.tileIds).size !== state.tileIds.length) throw new Error('Runtime must contain 33 unique playable tiles');
  if (!state.tileIds.includes(state.activeTileId)) throw new Error('Active tile is not playable');
  if (state.sliverTileIds.length !== 2) throw new Error('Runtime must retain two non-playable sliver records');
  if (state.checkpoints.entries.length > CHECKPOINT_LIMIT) throw new Error('Checkpoint retention exceeded ten');
  if (state.pendingTransition !== null) throw new Error('A committed action left a transition pending');
  if (state.metrics.maxTransitionTouchedTiles > 2) throw new Error('A transition touched more than source and destination');
  if (state.metrics.maxDeserializedTiles > 1) throw new Error('An operation deserialized more than one tile');
  const references = referencedBlobHashes(state);
  for (const hash of references) if (!state.blobs[hash]) throw new Error(`Dangling blob reference: ${hash}`);
  for (const object of state.globalNetwork.objects) if (!state.tileIds.includes(object.ownerTileId)) throw new Error(`Network object has invalid owner: ${object.id}`);
  return state;
}

