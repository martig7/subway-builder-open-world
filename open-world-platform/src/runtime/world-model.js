import { assertCommuteLedger, createCommuteEntry, migrateCommuteLedger } from './cross-tile-commute-engine.js';

/** Domain-only state helpers.  Game save payloads are deliberately opaque. */

export function deepCopy(value) { return value === undefined ? undefined : structuredClone(value); }

function normalizedTileIds(tileIds) {
  const result = [...(tileIds ?? [])].map(String);
  if (!result.length || new Set(result).size !== result.length) throw new Error('World tile IDs must be a non-empty unique list');
  return result;
}

export function createTileState(worldTime = 0) {
  return {
    revision: 0,
    lastSimulatedTime: worldTime,
    snapshot: null,
    networkProfile: null,
    aggregate: { ridership: 0, revenue: 0, operatingCost: 0, backlog: 0 },
  };
}

export function createWorld({ worldId, tileIds, activeTileId = null, worldTime = 0, elapsedSeconds = worldTime * 3600, wallet = 0, gameMode = null, cohorts = [] }) {
  const ids = normalizedTileIds(tileIds);
  activeTileId ??= ids[0];
  if (!ids.includes(activeTileId)) throw new Error(`Unknown active tile: ${activeTileId}`);
  const gatewayLedger = Object.fromEntries(cohorts.map((cohort) => [cohort.id, createCommuteEntry(cohort)]));
  const tiles = Object.fromEntries(ids.map((id) => [id, createTileState(worldTime)]));
  return {
    schemaVersion: 1, worldId, tileIds: ids, activeTileId, worldTime, elapsedSeconds, wallet, gameMode, farePolicy: { fare: 2.5 },
    revision: 0, tiles, gatewayLedger, gatewayCatalog: {}, commuteCatalogBuildHash: null,
    commuteLastProcessedHour: worldTime, crossModeShare: null, crossPopModeChoices: {},
    crossTileFinancials: { transitTrips: 0, fareRevenue: 0, pendingNativeRevenue: 0 },
    pendingCrossTileAttribution: { revenueByRoute: {}, completedCommutes: [] },
    settlementAccountingSchemaVersion: 2,
    settlementFinanceQuarantine: null,
    financialHistory: null,
    backgroundNativeFinance: {
      schemaVersion: 2,
      lastSettledHour: worldTime,
      tileRevenueProfiles: {},
      expenseProfile: null,
      ownershipProjection: null,
      pendingHandoff: null,
      totalRevenue: 0,
      totalExpenses: 0,
      audit: { schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null },
    },
    globalNetwork: null,
    activeProjection: null,
    projectionOverlay: { type: 'FeatureCollection', features: [] },
    projectionWarning: null,
    committedTransitionId: null, pendingTransition: null,
  };
}

export function migrateWorldTileSet(world, tileIds = world?.tileIds ?? Object.keys(world?.tiles ?? {})) {
  const ids = normalizedTileIds(tileIds);
  world.tileIds = ids;
  world.tiles ??= {};
  for (const tileId of ids) world.tiles[tileId] ??= createTileState(world.worldTime ?? 0);
  if (world.backgroundNativeFinance?.schemaVersion !== 2) world.backgroundNativeFinance = {
    schemaVersion: 2,
    lastSettledHour: null,
    tileRevenueProfiles: {},
    expenseProfile: null,
    ownershipProjection: null,
    pendingHandoff: null,
    totalRevenue: 0,
    totalExpenses: 0,
    audit: { schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null },
  };
  world.backgroundNativeFinance.audit ??= {
    schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null,
  };
  world.backgroundNativeFinance.ownershipProjection ??= null;
  world.backgroundNativeFinance.pendingHandoff ??= null;
  return world;
}

export function assertWorld(world, tileIds = world?.tileIds ?? Object.keys(world?.tiles ?? {})) {
  if (!world || world.schemaVersion !== 1) throw new Error('Unsupported world state schema');
  const ids = normalizedTileIds(tileIds);
  if (!ids.includes(world.activeTileId)) throw new Error('World has no valid active tile');
  if (!Number.isSafeInteger(world.revision) || world.revision < 0) throw new Error('Invalid world revision');
  if (!Number.isFinite(world.elapsedSeconds) || world.elapsedSeconds < 0) throw new Error('Invalid exact world time');
  world.gameMode ??= null;
  if (world.gameMode !== null && !['easy', 'sandbox'].includes(world.gameMode)) throw new Error('Invalid world game mode');
  for (const tileId of ids) {
    const tile = world.tiles[tileId];
    if (!tile || !Number.isSafeInteger(tile.revision) || tile.revision < 0) throw new Error(`Invalid tile revision: ${tileId}`);
    if (tile.lastSimulatedTime > world.worldTime) throw new Error(`Tile clock is ahead of world: ${tileId}`);
    tile.networkProfile ??= null;
  }
  world.tileIds = ids;
  world.crossModeShare ??= null;
  world.globalNetwork ??= null;
  world.activeProjection ??= null;
  world.projectionOverlay ??= { type: 'FeatureCollection', features: [] };
  world.projectionWarning ??= null;
  world.settlementFinanceQuarantine ??= null;
  if (world.backgroundNativeFinance?.schemaVersion !== 2) world.backgroundNativeFinance = {
    schemaVersion: 2,
    lastSettledHour: world.worldTime,
    tileRevenueProfiles: {},
    expenseProfile: null,
    ownershipProjection: null,
    pendingHandoff: null,
    totalRevenue: 0,
    totalExpenses: 0,
    audit: { schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null },
  };
  world.backgroundNativeFinance.audit ??= {
    schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null,
  };
  world.backgroundNativeFinance.ownershipProjection ??= null;
  world.backgroundNativeFinance.pendingHandoff ??= null;
  migrateCommuteLedger(world);
  return assertCommuteLedger(world);
}
