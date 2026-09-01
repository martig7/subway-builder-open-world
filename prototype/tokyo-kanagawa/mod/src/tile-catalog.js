import catalogSource from '../../generated/catalog/tokyo-kanagawa-tile-catalog.json' with { type: 'json' };
import boundarySource from '../../../japan/generated/tokyo-kanagawa-test/world-boundary-overlay.json' with { type: 'json' };

const boundaryByPrefCode = new Map(
  boundarySource.features.map((feature) => [String(feature.properties.pref_code), feature.geometry]),
);

function normalizeInitialViewState(view = {}) {
  const center = Array.isArray(view.center) ? view.center : null;
  return Object.freeze({
    longitude: Number(view.longitude ?? center?.[0]),
    latitude: Number(view.latitude ?? center?.[1]),
    zoom: Number(view.zoom),
    bearing: Number(view.bearing ?? 0),
  });
}

function initialViewCenter(view = {}) {
  const normalized = normalizeInitialViewState(view);
  return Object.freeze([normalized.longitude, normalized.latitude]);
}

export const PILOT_TILE_IDS = Object.freeze(
  catalogSource.tiles
    .filter((tile) => tile.status === 'selected')
    .map((tile) => tile.id),
);

const tiles = catalogSource.tiles
  .filter((tile) => tile.status === 'selected')
  .map((tile) => Object.freeze({
    ...tile,
    name: tile.name,
    cityName: `${tile.name} Open World`,
    description: `${tile.name} mainland statistical-demand map package`,
    population: 0,
    boundaryGeometry: boundaryByPrefCode.get(String(tile.prefCode)) ?? null,
    initialViewState: normalizeInitialViewState(tile.initialViewState ?? tile.initialView),
    neighbors: Object.freeze(tile.neighbors ?? []),
  }));

if (tiles.length !== 2) throw new Error(`Tokyo–Kanagawa catalog must contain 2 selected tiles; found ${tiles.length}`);
if (tiles.some((tile) => !tile.boundaryGeometry)) {
  throw new Error('Tokyo–Kanagawa catalog requires a prefecture boundary geometry for every selected tile');
}

export const tileCatalog = Object.freeze({
  ...catalogSource,
  id: 'JP_TOKYO_KANAGAWA_MAINLAND',
  name: 'Tokyo–Kanagawa mainland open world',
  minZoom: 0.01,
  maxZoom: 15,
  basemapMinZoom: 0.01,
  initialView: Object.freeze({
    center: initialViewCenter(catalogSource.initialView),
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
