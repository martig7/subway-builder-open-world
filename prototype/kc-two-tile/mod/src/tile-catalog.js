export const tileCatalog = Object.freeze({
  schemaVersion: 1,
  id: 'KCOW',
  name: 'Kansas City open world',
  basemapMinZoom: 3,
  minZoom: 8,
  maxZoom: 15,
  initialView: Object.freeze({ center: [-94.607, 39.0], zoom: 10.6 }),
  tiles: Object.freeze([
    Object.freeze({
      id: 'KCW', name: 'West', cityName: 'Kansas City Open World — West',
      description: 'Kansas City west ownership tile', population: 1_200_000,
      column: 0, row: 0,
      bounds: [-94.8955, 38.8875, -94.6070, 39.1125],
      initialViewState: Object.freeze({ zoom: 10.8, latitude: 39.0, longitude: -94.751, bearing: 0 }),
    }),
    Object.freeze({
      id: 'KCE', name: 'East', cityName: 'Kansas City Open World — East',
      description: 'Kansas City east ownership tile', population: 1_200_000,
      column: 1, row: 0,
      bounds: [-94.6070, 38.8875, -94.3185, 39.1125],
      initialViewState: Object.freeze({ zoom: 10.8, latitude: 39.0, longitude: -94.463, bearing: 0 }),
    }),
  ]),
  context: Object.freeze([
    Object.freeze({
      kind: 'water',
      coordinates: Object.freeze([
        [-94.91, 39.075], [-94.80, 39.083], [-94.70, 39.095], [-94.62, 39.115],
        [-94.55, 39.125], [-94.46, 39.112], [-94.34, 39.096],
      ]),
    }),
    Object.freeze({
      kind: 'water',
      coordinates: Object.freeze([
        [-94.69, 38.89], [-94.66, 38.94], [-94.63, 38.99], [-94.62, 39.04], [-94.62, 39.115],
      ]),
    }),
  ]),
});

export const TILE_IDS = Object.freeze(tileCatalog.tiles.map((tile) => tile.id));
export const tileById = new Map(tileCatalog.tiles.map((tile) => [tile.id, tile]));
