import test from 'node:test';
import assert from 'node:assert/strict';

import { TileMapController, TILE_MAP_VIEWPORT } from '../../../../open-world-platform/src/runtime/ui/prototype-panel.js';
import { boundsPolygon, visibleSlippyGrid } from '../../../../open-world-platform/src/runtime/tile-map-model.js';
import { tileCatalog } from '../src/tile-catalog.js';

function createController() {
  const activeTileId = tileCatalog.tiles[0].id;
  return new TileMapController({
    api: { utils: { getCityCode: () => activeTileId } },
    runtime: {
      view: () => ({
        activeTileId,
        commutes: { globalBacklog: 0 },
        commutesByTile: {},
        partialRouteServices: [],
      }),
      subscribe: () => () => {},
    },
    navigation: {},
    catalog: tileCatalog,
  });
}

test('NEC World tiles preview produces finite SVG geometry', () => {
  const controller = createController();
  const snapshot = controller.snapshot();
  const polygon = boundsPolygon(snapshot.tiles[0].bounds, snapshot.mapView, TILE_MAP_VIEWPORT);
  const grid = visibleSlippyGrid(snapshot.mapView, TILE_MAP_VIEWPORT);

  assert.ok(Number.isFinite(snapshot.mapView.zoom), `preview zoom must be finite: ${snapshot.mapView.zoom}`);
  assert.ok(polygon.flat().every(Number.isFinite), `preview polygon must be finite: ${JSON.stringify(polygon)}`);
  assert.ok(grid.vertical.every((line) => Number.isFinite(line.position)));
  assert.ok(grid.horizontal.every((line) => Number.isFinite(line.position)));
});
