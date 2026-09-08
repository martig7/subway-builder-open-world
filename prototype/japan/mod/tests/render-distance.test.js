import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../../../../worlds/japan/geography/tile-views.json' with { type: 'json' };
import { precomputeRenderDistance } from '../../../../open-world-platform/src/runtime/render-distance.js';
import { createRendererVirtualization } from '../../../../open-world-platform/src/runtime/ui/renderer-virtualization.js';

test('Japan maximum renders all prefecture corners from every selected prefecture', () => {
  const renderDistance = precomputeRenderDistance(catalog);
  const tileCatalog = { ...catalog, tiles: catalog.tiles.filter(t => t.status === 'selected'), renderDistance };
  for (const origin of tileCatalog.tiles) {
    for (const renderShape of ['circle', 'square']) {
      const renderer = createRendererVirtualization({ activeTileId: origin.id, tileCatalog, renderDistance: renderDistance.max, renderShape });
      for (const tile of tileCatalog.tiles) {
        const [w, s, e, n] = tile.bounds;
        for (const point of [[w,s], [w,n], [e,s], [e,n]]) assert.ok(renderer.contains(point), `${origin.id} to ${tile.id}`);
      }
    }
  }
  const minima = Object.values(renderDistance.minByTile);
  assert.ok(Math.max(...minima) > Math.min(...minima) * 2);
});
