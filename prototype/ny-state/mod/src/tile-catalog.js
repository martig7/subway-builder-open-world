import { NY_TILE_CATALOG } from '../../generated/catalog/tile-catalog.generated.js';

export const PILOT_TILE_IDS = Object.freeze([
  'NY_CP00_RP00',
  'NY_CP00_RP01',
  'NY_CP01_RP00',
  'NY_CM01_RP01',
  'NY_CM01_RP02',
  'NY_CM01_RP03',
  'NY_CP00_RP02',
]);

const labels = Object.freeze({
  NY_CP00_RP00: 'New York City',
  NY_CP00_RP01: 'Lower Hudson',
  NY_CP01_RP00: 'Long Island',
  NY_CM01_RP01: 'Catskills',
  NY_CM01_RP02: 'Mohawk Valley',
  NY_CM01_RP03: 'Adirondacks',
  NY_CP00_RP02: 'Albany / Capital Region',
});

// Exact projected-cell outlines from the generated coverage catalog. These
// are deliberately not axis-aligned lon/lat rectangles: the source grid is
// square in its projected CRS, so its geographic edges lean slightly.
const boundaries = Object.freeze({
  NY_CP00_RP00: [[-73.45306094651934, 40.49005366648574], [-73.4324860255007, 41.36624187257424], [-74.36142043065041, 41.3751470116748], [-74.36980573812328, 40.498689586118495], [-73.45306094651934, 40.49005366648574]],
  NY_CP01_RP00: [[-72.5368797960823, 40.474153405451695], [-72.50414422253851, 41.34984611859816], [-73.4324860255007, 41.36624187257424], [-73.45306094651934, 40.49005366648574], [-72.5368797960823, 40.474153405451695]],
  NY_CM01_RP01: [[-74.36142043065041, 41.3751470116748], [-74.35265605465452, 42.25146906459063], [-75.29458508923994, 42.25291758477143], [-75.2905964442446, 41.37655191014284], [-74.36142043065041, 41.3751470116748]],
  NY_CP00_RP01: [[-73.4324860255007, 41.36624187257424], [-73.4109813494552, 42.2422874688255], [-74.35265605465452, 42.25146906459063], [-74.36142043065041, 41.3751470116748], [-73.4324860255007, 41.36624187257424]],
  NY_CM01_RP02: [[-74.35265605465452, 42.25146906459063], [-74.3434926437689, 43.12765522731695], [-75.29875534568087, 43.12914858057401], [-75.29458508923994, 42.25291758477143], [-74.35265605465452, 42.25146906459063]],
  NY_CP00_RP02: [[-73.4109813494552, 42.2422874688255], [-73.38849798249363, 43.11818950214902], [-74.3434926437689, 43.12765522731695], [-74.35265605465452, 42.25146906459063], [-73.4109813494552, 42.2422874688255]],
  NY_CM01_RP03: [[-74.3434926437689, 43.12765522731695], [-74.33390867656932, 44.003705101884066], [-75.30311700972578, 44.00524457347418], [-75.29875534568087, 43.12914858057401], [-74.3434926437689, 43.12765522731695]],
});

const localWorkers = Object.freeze({
  NY_CP00_RP00: 4_081_572,
  NY_CP00_RP01: 158_447,
  NY_CP01_RP00: 389_140,
  NY_CM01_RP01: 30_159,
  NY_CM01_RP02: 52_344,
  NY_CM01_RP03: 2_607,
  NY_CP00_RP02: 321_968,
});

const pilotSet = new Set(PILOT_TILE_IDS);
const tiles = NY_TILE_CATALOG.tiles
  .filter((tile) => pilotSet.has(tile.id))
  .map((tile) => Object.freeze({
    ...tile,
    name: labels[tile.id],
    cityName: `New York Open World — ${labels[tile.id]}`,
    description: `NYC-sized performance pilot tile: ${labels[tile.id]}`,
    population: localWorkers[tile.id],
    boundary: Object.freeze(boundaries[tile.id].map((point) => Object.freeze(point))),
    neighbors: Object.freeze(tile.neighbors.filter((neighbor) => pilotSet.has(neighbor.tileId))),
  }));

// Complete projected-grid cells around every selectable pilot tile. These are
// spatial validation cells, not loadable city packages; keeping them separate
// makes the editable halo a real 3x3 even over New Jersey, ocean, or other
// cells omitted by the New-York-intersection package catalog.
const spatialTiles = Object.freeze([
  [-2, 0, -76.2196625, 40.49413948, -75.28678032, 41.37655191], [-2, 1, -76.23639837, 41.37045505, -75.29059644, 42.25291758],
  [-2, 2, -76.25389605, 42.24663143, -75.29458509, 43.12914858], [-2, 3, -76.27219661, 43.12266788, -75.29875535, 44.00524457],
  [-2, 4, -76.29134437, 43.99856375, -75.30311701, 44.88120536], [-1, -1, -75.28678032, 39.62209743, -74.36980574, 40.50005201],
  [-1, 0, -75.29059644, 40.49868959, -74.36142043, 41.37655191], [-1, 1, -75.29458509, 41.37514701, -74.35265605, 42.25291758],
  [-1, 2, -75.29875535, 42.25146906, -74.34349264, 43.12914858], [-1, 3, -75.30311701, 43.12765523, -74.33390868, 44.00524457],
  [-1, 4, -75.30768065, 44.0037051, -74.32388093, 44.88120536], [0, -1, -74.37783052, 39.61372389, -73.45306095, 40.49868959],
  [0, 0, -74.36980574, 40.49005367, -73.43248603, 41.37514701], [0, 1, -74.36142043, 41.36624187, -73.41098135, 42.25146906],
  [0, 2, -74.35265605, 42.24228747, -73.38849798, 43.12765523], [0, 3, -74.34349264, 43.1181895, -73.36498318, 44.0037051],
  [0, 4, -74.33390868, 43.99394711, -73.34038003, 44.87961841], [1, -1, -73.47275157, 39.59830657, -72.5368798, 40.49005367],
  [1, 0, -73.45306095, 40.47415341, -72.50414422, 41.36624187], [1, 1, -73.43248603, 41.34984612, -72.46993042, 42.24228747],
  [1, 2, -73.41098135, 42.22538292, -72.4341607, 43.1181895], [1, 3, -73.38849798, 43.10076206, -72.39675133, 43.99394711],
  [2, -1, -72.56820932, 39.57586149, -71.62159484, 40.47415341], [2, 0, -72.5368798, 40.45100565, -71.5767446, 41.34984612],
  [2, 1, -72.50414422, 41.32597745, -71.52987119, 42.22538292],
].map(([column, row, ...bounds]) => Object.freeze({
  id: `__spatial_${column}_${row}`, column, row, status: 'normal', bounds: Object.freeze(bounds),
})));

if (tiles.length !== PILOT_TILE_IDS.length) throw new Error('New York pilot catalog is incomplete');

export const tileCatalog = Object.freeze({
  ...NY_TILE_CATALOG,
  schemaVersion: 1,
  id: 'NYS_CORRIDOR_7',
  name: 'New York seven-tile corridor performance canary',
  // The archive metadata reports minzoom=0. The native renderer uses
  // `city.minZoom || 10`, so a small truthy value is required to reach it.
  basemapMinZoom: 0.01,
  initialView: Object.freeze({ center: [-74.35, 42.1], zoom: 6.5 }),
  selection: Object.freeze({ addressableCount: tiles.length, normalCount: tiles.length, sliverCount: 0 }),
  // Projection/edit validation needs the geographic cells around the active
  // tile even when those cells are not part of this seven-package canary.
  // The switcher and package loader continue to use `tiles` above.
  spatialTiles,
  tiles: Object.freeze(tiles),
});

export const tileById = new Map(tiles.map((tile) => [tile.id, tile]));
