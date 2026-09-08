import test from 'node:test';
import assert from 'node:assert/strict';
import { precomputeRenderDistance, renderDistanceLimits } from '../src/runtime/render-distance.js';
import { createRendererVirtualization, clipLineStringWithValues } from '../src/runtime/ui/renderer-virtualization.js';

const tiles = [
  { id: 'small', bounds: [139, 35, 139.02, 35.02] },
  { id: 'large', bounds: [139.02, 35, 140, 36] },
  { id: 'remote', bounds: [130, 30, 131, 31] },
];
const catalog = { tiles };

test('uneven tiles use metric bounds, independent of grid coordinates or catalog order', () => {
  const metadata = precomputeRenderDistance(catalog);
  assert.ok(metadata.minByTile.large > metadata.minByTile.small * 40);
  const a = createRendererVirtualization({ tileCatalog: catalog, activeTileId: 'small', renderDistance: 10 });
  const b = createRendererVirtualization({ tileCatalog: { tiles: tiles.toReversed().map(t => ({ ...t, column: 0, row: 0 })) }, activeTileId: 'small', renderDistance: 10 });
  for (const point of [[139.01, 35.01], [139.05, 35.05], [139.5, 35.5]]) assert.equal(a.contains(point), b.contains(point));
  assert.equal(a.contains([139.5, 35.5]), false, 'large adjacent tile is only partially visible');
});

test('minimum circle covers every selected tile corner and maximum covers the world from every origin', () => {
  for (const tile of tiles) {
    const limits = renderDistanceLimits(catalog, tile.id);
    for (const shape of ['circle', 'square']) {
      const min = createRendererVirtualization({ tileCatalog: catalog, activeTileId: tile.id, renderDistance: limits.min, renderShape: shape });
      const max = createRendererVirtualization({ tileCatalog: catalog, activeTileId: tile.id, renderDistance: limits.max, renderShape: shape });
      for (const target of tiles) {
        const [w, s, e, n] = target.bounds;
        for (const p of [[w, s], [w, n], [e, s], [e, n]]) {
          assert.ok(max.contains(p), `${tile.id} -> ${target.id}: ${shape}`);
          if (target === tile) assert.ok(min.contains(p));
        }
      }
    }
  }
});

test('circle and square clip between tile edges and interpolate binary attributes', () => {
  const metadata = precomputeRenderDistance(catalog);
  const [sx, sy] = metadata.scale;
  const p = (x, y) => [139.01 + x / sx, 35.01 + y / sy];
  const circle = createRendererVirtualization({ tileCatalog: catalog, activeTileId: 'small', renderDistance: 10 });
  const square = createRendererVirtualization({ tileCatalog: catalog, activeTileId: 'small', renderDistance: 10, renderShape: 'square' });
  assert.equal(circle.contains(p(8, 8)), false);
  assert.equal(square.contains(p(8, 8)), true);
  const [line] = clipLineStringWithValues([p(-20, 6), p(20, 6)], [0, 40], circle.haloBounds);
  assert.ok(Math.abs(line.values[0] - 12) < 1e-8);
  assert.ok(Math.abs(line.values[1] - 28) < 1e-8);
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[p(-20,-20), p(20,-20), p(20,20), p(-20,20), p(-20,-20)]] } };
  const result = circle.presentation(feature);
  assert.ok(result.geometry.coordinates[0].length > 100);
  assert.equal(feature.geometry.coordinates[0].length, 5);
});

test('precomputation refreshes maximum and per-tile minimum after catalog geometry changes', () => {
  const before = precomputeRenderDistance(catalog);
  const after = precomputeRenderDistance({ tiles: [...tiles, { id: 'new', bounds: [120, 20, 121, 21] }] });
  assert.ok(after.max > before.max);
  assert.ok(after.minByTile.new > 0);
});
