export const definition = Object.freeze({
  identity: Object.freeze({ name: 'Kansas City Open World Fixture' }),
  map: Object.freeze({ basemapRevision: 'kcow-fixture-v1' }),
  runtime: Object.freeze({ tileServerPort: 8788 }),
});

export const tileCatalog = Object.freeze({
  schemaVersion: 1,
  id: 'KCOW_FIXTURE',
  name: 'Kansas City open-world fixture',
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
  context: Object.freeze([]),
});
