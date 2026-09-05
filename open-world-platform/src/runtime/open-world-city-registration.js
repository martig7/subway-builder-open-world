export function createOpenWorldCityRegistration({ definition, tileCatalog }) {
  const defaultTileBase = `http://127.0.0.1:${definition.runtime.tileServerPort}`;
  const basemapRevision = definition.map.basemapRevision;
  const label = definition.identity.name;

  function cityDefinitionsFor(catalog = tileCatalog) {
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

  function tileUrl(city, tileBase = defaultTileBase) {
    return `${tileBase}/${city.tileId}/{z}/{x}/{y}.mvt?v=${basemapRevision}`;
  }

  function refreshPilotCityBindings(api, { tileBase = defaultTileBase, catalog = tileCatalog, cityCodes = null } = {}) {
    if (typeof api?.map?.setTileURLOverride !== 'function') throw new Error(`[${label}] map.setTileURLOverride is unavailable`);
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
      api.map.setTileURLOverride({ cityCode: code, tilesUrl: tileUrl(city, tileBase), maxZoom: catalog.maxZoom ?? 15 });
      api.map.setDefaultLayerVisibility(code, { oceanFoundations: false, buildingFoundations: false });
    }
    return definitions.map(({ code }) => code);
  }

  function repairPilotMapTileSource(map, cityCode, { tileBase = defaultTileBase, catalog = tileCatalog } = {}) {
    const city = cityDefinitionsFor(catalog).find((candidate) => candidate.code === cityCode);
    if (!city) return { status: 'not-open-world-city', cityCode };
    const tilesUrl = tileUrl(city, tileBase);
    const source = map?.getSource?.('general-tiles');
    if (!source) return { status: 'source-unavailable', cityCode, tilesUrl };
    const currentTiles = Array.isArray(source.tiles) ? source.tiles : source._options?.tiles;
    if (currentTiles?.length === 1 && currentTiles[0] === tilesUrl) return { status: 'current', cityCode, tilesUrl };
    if (typeof source.setTiles !== 'function') return { status: 'set-tiles-unavailable', cityCode, tilesUrl, currentTiles };
    source.setTiles([tilesUrl]);
    let styleRebound = false;
    const style = map?.getStyle?.();
    const serializedSource = style?.sources?.['general-tiles'];
    if (serializedSource && serializedSource.tiles?.[0] !== tilesUrl && typeof map?.setStyle === 'function') {
      map.setStyle({
        ...style,
        sources: { ...style.sources, 'general-tiles': { ...serializedSource, tiles: [tilesUrl] } },
      }, { diff: true });
      styleRebound = true;
    }
    return { status: 'repaired', cityCode, tilesUrl, previousTiles: currentTiles, styleRebound };
  }

  function repairPilotMapCamera(map, cityCode, { catalog = tileCatalog, minimumLocalZoom = 10, force = false } = {}) {
    const city = cityDefinitionsFor(catalog).find((candidate) => candidate.code === cityCode);
    const tile = catalog.tiles.find((candidate) => (candidate.gameCityCode ?? candidate.id) === cityCode);
    if (!city || !tile) return { status: 'not-open-world-city', cityCode };
    const zoom = Number(map?.getZoom?.());
    if (!Number.isFinite(zoom)) return { status: 'camera-unavailable', cityCode };
    if (!force && zoom < minimumLocalZoom) return { status: 'world-view', cityCode, zoom };
    const rawCenter = map?.getCenter?.();
    const longitude = Number(rawCenter?.lng ?? rawCenter?.lon ?? rawCenter?.[0]);
    const latitude = Number(rawCenter?.lat ?? rawCenter?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return { status: 'camera-unavailable', cityCode, zoom };
    const [west, south, east, north] = tile.bounds ?? [];
    if (!force && longitude >= west && longitude <= east && latitude >= south && latitude <= north) {
      return { status: 'current', cityCode, zoom, center: [longitude, latitude] };
    }
    if (typeof map?.jumpTo !== 'function') return { status: 'jump-unavailable', cityCode, zoom, center: [longitude, latitude] };
    map.jumpTo({ center: [city.initialViewState.longitude, city.initialViewState.latitude], zoom: city.initialViewState.zoom, bearing: city.initialViewState.bearing ?? 0 });
    return { status: 'recentered', cityCode, previousCenter: [longitude, latitude], previousZoom: zoom };
  }

  function registerPilotCities(api, { tileBase = defaultTileBase, catalog = tileCatalog } = {}) {
    if (typeof api?.map?.setTileURLOverride !== 'function') throw new Error(`[${label}] map.setTileURLOverride is unavailable`);
    const definitions = cityDefinitionsFor(catalog);
    for (const city of definitions) {
      const existing = api.utils.getCities().find((candidate) => candidate.code === city.code);
      if (!existing) api.registerCity(city);
      else if (existing.minZoom !== city.minZoom) existing.minZoom = city.minZoom;
    }
    refreshPilotCityBindings(api, { tileBase, catalog });
    return { tileBase, cities: definitions.map(({ code }) => code), tileIds: definitions.map(({ tileId }) => tileId) };
  }

  return {
    cityDefinitionsFor,
    defaultTileBase,
    tileUrl,
    refreshPilotCityBindings,
    registerPilotCities,
    repairPilotMapCamera,
    repairPilotMapTileSource,
  };
}
