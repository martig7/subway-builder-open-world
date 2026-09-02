import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsPolygon, catalogBounds, fitBoundsView } from '../../../../open-world-platform/src/runtime/tile-map-model.js';
import { tileCatalog } from '../src/tile-catalog.js';

test('NEC world-tile SVG geometry has finite polygon and label coordinates', () => {
  const viewport = { width: 344, height: 230 };
  const view = fitBoundsView(catalogBounds(tileCatalog.tiles), viewport, 28, tileCatalog);
  assert.ok(Number.isFinite(view.zoom), 'world-tile view zoom');

  for (const tile of tileCatalog.tiles) {
    const polygon = boundsPolygon(tile.bounds, view, viewport);
    assert.equal(polygon.length, 4, `${tile.id} polygon point count`);
    assert.ok(polygon.flat().every(Number.isFinite), `${tile.id} SVG polygon points`);
    const center = polygon.reduce(
      (sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length],
      [0, 0],
    );
    assert.ok(center.every(Number.isFinite), `${tile.id} SVG label coordinates`);
  }
});
