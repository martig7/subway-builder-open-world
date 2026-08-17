import catalogSource from '../../generated/catalog/nec-tile-catalog.json' with { type: 'json' };

export const PILOT_TILE_IDS = Object.freeze(
  catalogSource.tiles
    .filter((tile) => tile.status === 'selected')
    .map((tile) => tile.id),
);

const tiles = catalogSource.tiles
  .filter((tile) => tile.status === 'selected')
  .map((tile) => Object.freeze({
    ...tile,
    name: `Grid ${tile.column}, ${tile.row}`,
    cityName: `Northeast Corridor — Grid ${tile.column}, ${tile.row}`,
    description: `NY-sized Northeast Corridor tile at grid column ${tile.column}, row ${tile.row}`,
    population: 0,
    neighbors: Object.freeze(tile.neighbors ?? []),
  }));

if (tiles.length !== 34) throw new Error(`NEC catalog must contain 34 selected tiles; found ${tiles.length}`);

export const tileCatalog = Object.freeze({
  ...catalogSource,
  id: 'NEC_CORRIDOR_34',
  name: 'Northeast Corridor 34-tile open world',
  basemapMinZoom: 0.01,
  initialView: Object.freeze({
    center: [...catalogSource.initialView.center],
    zoom: catalogSource.initialView.zoom,
  }),
  selection: Object.freeze({
    addressableCount: tiles.length,
    normalCount: tiles.length,
    sliverCount: 0,
  }),
  tiles: Object.freeze(tiles),
});

export const tileById = new Map(tiles.map((tile) => [tile.id, tile]));
