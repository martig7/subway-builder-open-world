import { createPackedBoundaryLookup } from './packed-display-boundaries.js';

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

function boundaryIndex(boundaryOverlay) {
  return new Map((boundaryOverlay?.features ?? []).map((feature) => [
    String(feature.properties?.pref_code ?? feature.properties?.prefCode ?? feature.properties?.id),
    feature.geometry,
  ]));
}

export function createOpenWorldCatalog({ definition, catalogSource, boundaryOverlay = null }) {
  if (!definition || !catalogSource) throw new Error('Catalog creation requires a World Definition and catalog source');
  const boundaries = boundaryIndex(boundaryOverlay);
  const packed = createPackedBoundaryLookup(boundaryOverlay);
  const lodIndexes = packed ? null : boundaryOverlay?.lods?.map(boundaryIndex);
  const selected = (catalogSource.tiles ?? []).filter((tile) => tile.status === 'selected');
  const tiles = selected.map((tile) => {
    const gridName = Number.isInteger(tile.column) && Number.isInteger(tile.row)
      ? `Grid ${tile.column}, ${tile.row}`
      : tile.name ?? tile.id;
    const boundaryKey = tile.prefCode ?? tile.pref_code ?? tile.id;
    return Object.freeze({
      ...tile,
      name: gridName,
      cityName: tile.cityName ?? `${gridName} Open World`,
      description: tile.description ?? `${gridName} map package`,
      population: Number(tile.population ?? 0),
      get boundaryGeometry() {
        return tile.boundaryGeometry ?? (packed ? packed.geometry(String(boundaryKey), 0) : boundaries.get(String(boundaryKey))) ?? null;
      },
      boundaryLods: boundaryOverlay?.lods?.map((level, index) => ({
        minZoom: level.minZoom,
        get geometry() {
          return packed ? packed.geometry(String(boundaryKey), index) : lodIndexes[index].get(String(boundaryKey)) ?? null;
        },
      })).filter((level, index) => packed ? packed.has(String(boundaryKey), index) : level.geometry) ?? tile.boundaryLods ?? [],
      initialViewState: normalizeInitialViewState(tile.initialViewState ?? tile.initialView),
      neighbors: Object.freeze(tile.neighbors ?? []),
    });
  });
  if (tiles.length === 0) throw new Error(`${definition.identity.name} has no selected Tile Views`);
  if (!tiles.some((tile) => tile.id === definition.tileViews.initialTileId)) {
    throw new Error(`Initial Tile View is not selected: ${definition.tileViews.initialTileId}`);
  }
  const sourceInitialView = catalogSource.initialView ?? tiles[0].initialViewState;
  const catalog = Object.freeze({
    ...catalogSource,
    id: catalogSource.id ?? definition.identity.artifactWorldId,
    name: catalogSource.name ?? definition.identity.name,
    minZoom: Number(catalogSource.minZoom ?? 0.01),
    maxZoom: Number(catalogSource.maxZoom ?? 15),
    basemapMinZoom: Number(catalogSource.basemapMinZoom ?? catalogSource.minZoom ?? 0.01),
    initialView: Object.freeze({
      center: initialViewCenter(sourceInitialView),
      zoom: Number(sourceInitialView.zoom),
    }),
    selection: Object.freeze({
      addressableCount: tiles.length,
      normalCount: tiles.length,
      sliverCount: 0,
    }),
    tiles: Object.freeze(tiles),
  });
  return {
    PILOT_TILE_IDS: Object.freeze(tiles.map((tile) => tile.id)),
    tileCatalog: catalog,
    tileById: new Map(tiles.map((tile) => [tile.id, tile])),
  };
}
