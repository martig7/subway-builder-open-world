export const cohorts = [{ id: 'cohort-west-east-1', mass: 10, originTileId: 'KCW', destinationTileId: 'KCE', gatewayId: 'central', travelHours: 2 }];
const commuteCatalog = {
  buildHash: 'two-tile-fixture-v1',
  buckets: [{ id: 'cohort-west-east-1', mass: 10, homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', defaultTravelSeconds: 7200, defaultCapacityPerHour: 100 }],
  gateways: [{ id: 'central', capacityPerHour: 100 }],
};
export const packages = {
  KCW: { manifest: { tileId: 'KCW', cityCode: 'KCW', schemaVersion: 1, dataFiles: { demandData: '/KCW/demand_data.json' } }, demand: [], commuteCatalog },
  KCE: { manifest: { tileId: 'KCE', cityCode: 'KCE', schemaVersion: 1, dataFiles: { demandData: '/KCE/demand_data.json' } }, demand: [], commuteCatalog },
};
