import { tileCatalog } from './tile-catalog.js';

export const DEFAULT_ARTIFACT_BASE = 'http://127.0.0.1:8787';
export const DEFAULT_TILE_BASE = 'http://127.0.0.1:8788';
export const CORRIDOR_TILESET = 'KCOW';

export function cityDefinitionsFor(catalog) {
  return catalog.tiles.filter((tile) => tile.status !== 'sliver').map((tile) => ({
    name: tile.cityName,
    code: tile.gameCityCode ?? tile.id,
    tileId: tile.id,
    description: tile.description,
    population: tile.population,
    initialViewState: tile.initialViewState,
    minZoom: catalog.basemapMinZoom,
  }));
}

export const cityDefinitions = cityDefinitionsFor(tileCatalog);

export function registerPrototypeCities(api, {
  artifactBase = DEFAULT_ARTIFACT_BASE,
  tileBase = DEFAULT_TILE_BASE,
  catalog = tileCatalog,
  tilesetId = catalog.id ?? CORRIDOR_TILESET,
} = {}) {
  if (typeof api?.map?.setTileURLOverride !== 'function') {
    throw new Error('[KC two-tile] map.setTileURLOverride is unavailable');
  }

  const dataFiles = (code) => ({
    demandData: `/data/${code}/demand_data.json.gz`,
    buildingsIndex: `/data/${code}/buildings_index.bin.gz`,
    roads: `/data/${code}/roads.geojson.gz`,
    runwaysTaxiways: `/data/${code}/runways_taxiways.geojson.gz`,
  });
  const definitions = cityDefinitionsFor(catalog);
  const tilesUrl = `${tileBase}/${tilesetId}/{z}/{x}/{y}.mvt`;

  for (const city of definitions) {
    const existing = api.utils.getCities().find((candidate) => candidate.code === city.code);
    if (!existing) api.registerCity(city);
    else if (existing.minZoom !== city.minZoom) existing.minZoom = city.minZoom;
    api.cities.setCityDataFiles(city.code, dataFiles(city.code));
    api.map.setTileURLOverride({ cityCode: city.code, tilesUrl, maxZoom: 15 });
    api.map.setDefaultLayerVisibility(city.code, { oceanFoundations: false, buildingFoundations: false });
  }

  return { artifactBase, tileBase, tilesUrl, cities: definitions.map(({ code }) => code), tileIds: definitions.map(({ tileId }) => tileId) };
}
