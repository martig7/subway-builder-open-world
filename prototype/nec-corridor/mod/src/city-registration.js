import { tileCatalog } from './tile-catalog.js';

export const DEFAULT_TILE_BASE = 'http://127.0.0.1:8799';
export const BASEMAP_REVISION = 'nec-corridor-z0-z9-v1';

export function cityDefinitionsFor(catalog = tileCatalog) {
  return catalog.tiles.map((tile) => ({
    name: tile.cityName,
    code: tile.gameCityCode ?? tile.id,
    tileId: tile.id,
    description: tile.description,
    population: tile.population,
    initialViewState: tile.initialViewState,
    minZoom: catalog.basemapMinZoom,
  }));
}

export function pilotTileUrl(city, tileBase = DEFAULT_TILE_BASE) {
  return `${tileBase}/${city.tileId}/{z}/{x}/{y}.mvt?v=${BASEMAP_REVISION}`;
}

export function refreshPilotCityBindings(
  api,
  { tileBase = DEFAULT_TILE_BASE, catalog = tileCatalog, cityCodes = null } = {},
) {
  if (typeof api?.map?.setTileURLOverride !== 'function') throw new Error('[NEC] map.setTileURLOverride is unavailable');
  const selectedCodes = cityCodes == null ? null : new Set(cityCodes);
  const definitions = cityDefinitionsFor(catalog).filter((city) => selectedCodes == null || selectedCodes.has(city.code));
  for (const city of definitions) {
    const code = city.code;
    api.cities.setCityDataFiles(code, {
      demandData: `/data/${code}/demand_data.json.gz`,
      buildingsIndex: `/data/${code}/buildings_index.bin.gz`,
      roads: `/data/${code}/roads.geojson.gz`,
      runwaysTaxiways: `/data/${code}/runways_taxiways.geojson.gz`,
    });
    api.map.setTileURLOverride({ cityCode: code, tilesUrl: pilotTileUrl(city, tileBase), maxZoom: 15 });
    api.map.setDefaultLayerVisibility(code, { oceanFoundations: false, buildingFoundations: false });
  }
  return definitions.map(({ code }) => code);
}

export function repairPilotMapTileSource(
  map,
  cityCode,
  { tileBase = DEFAULT_TILE_BASE, catalog = tileCatalog } = {},
) {
  const city = cityDefinitionsFor(catalog).find((candidate) => candidate.code === cityCode);
  if (!city) return { status: 'not-pilot-city', cityCode };
  const tilesUrl = pilotTileUrl(city, tileBase);
  const source = map?.getSource?.('general-tiles');
  if (!source) return { status: 'source-unavailable', cityCode, tilesUrl };
  const currentTiles = Array.isArray(source.tiles)
    ? source.tiles
    : Array.isArray(source._options?.tiles)
      ? source._options.tiles
      : null;
  if (currentTiles?.length === 1 && currentTiles[0] === tilesUrl) {
    return { status: 'current', cityCode, tilesUrl };
  }
  if (typeof source.setTiles !== 'function') {
    return { status: 'set-tiles-unavailable', cityCode, tilesUrl, currentTiles };
  }
  source.setTiles([tilesUrl]);

  // MapLibre normally reflects setTiles() in the serialized style. During a
  // native city transition, however, react-map-gl can still own an older
  // memoized style whose source points at map://. In that state the setter
  // reports success but the next style reconciliation restores the stale URL.
  // Patch the authoritative style too, but only when the setter did not.
  let styleRebound = false;
  const style = map?.getStyle?.();
  const serializedSource = style?.sources?.['general-tiles'];
  const serializedTiles = Array.isArray(serializedSource?.tiles) ? serializedSource.tiles : null;
  if (serializedSource
    && !(serializedTiles?.length === 1 && serializedTiles[0] === tilesUrl)
    && typeof map?.setStyle === 'function') {
    map.setStyle({
      ...style,
      sources: {
        ...style.sources,
        'general-tiles': {
          ...serializedSource,
          tiles: [tilesUrl],
        },
      },
    }, { diff: true });
    styleRebound = true;
  }
  return {
    status: 'repaired',
    cityCode,
    tilesUrl,
    previousTiles: currentTiles,
    styleRebound,
  };
}

export function repairPilotMapCamera(
  map,
  cityCode,
  { catalog = tileCatalog, minimumLocalZoom = 10 } = {},
) {
  const city = cityDefinitionsFor(catalog).find((candidate) => candidate.code === cityCode);
  const tile = catalog.tiles.find((candidate) => (candidate.gameCityCode ?? candidate.id) === cityCode);
  if (!city || !tile) return { status: 'not-pilot-city', cityCode };

  const zoom = Number(map?.getZoom?.());
  if (!Number.isFinite(zoom)) return { status: 'camera-unavailable', cityCode };
  if (zoom < minimumLocalZoom) return { status: 'world-view', cityCode, zoom };

  const rawCenter = map?.getCenter?.();
  const longitude = Number(rawCenter?.lng ?? rawCenter?.lon ?? rawCenter?.[0]);
  const latitude = Number(rawCenter?.lat ?? rawCenter?.[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return { status: 'camera-unavailable', cityCode, zoom };
  }

  const bounds = tile.bounds;
  const isInside = Array.isArray(bounds)
    && bounds.length === 4
    && longitude >= bounds[0]
    && longitude <= bounds[2]
    && latitude >= bounds[1]
    && latitude <= bounds[3];
  if (isInside) return { status: 'current', cityCode, zoom, center: [longitude, latitude] };
  if (typeof map?.jumpTo !== 'function') {
    return { status: 'jump-unavailable', cityCode, zoom, center: [longitude, latitude] };
  }

  const target = city.initialViewState;
  map.jumpTo({
    center: [target.longitude, target.latitude],
    zoom: target.zoom,
    bearing: target.bearing ?? 0,
  });
  return {
    status: 'recentered',
    cityCode,
    previousCenter: [longitude, latitude],
    previousZoom: zoom,
    center: [target.longitude, target.latitude],
    zoom: target.zoom,
  };
}

export function registerPilotCities(api, { tileBase = DEFAULT_TILE_BASE, catalog = tileCatalog } = {}) {
  if (typeof api?.map?.setTileURLOverride !== 'function') throw new Error('[NEC] map.setTileURLOverride is unavailable');
  const definitions = cityDefinitionsFor(catalog);
  for (const city of definitions) {
    const existing = api.utils.getCities().find((candidate) => candidate.code === city.code);
    if (!existing) api.registerCity(city);
    else if (existing.minZoom !== city.minZoom) existing.minZoom = city.minZoom;
  }
  refreshPilotCityBindings(api, { tileBase, catalog });
  return {
    tileBase,
    cities: definitions.map(({ code }) => code),
    tileIds: definitions.map(({ tileId }) => tileId),
  };
}
