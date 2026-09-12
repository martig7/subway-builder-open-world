import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererTileCacheBudget, RENDERER_TILE_CACHE_BUDGET_VERSION } from '../src/runtime/renderer-tile-cache-budget.js';

function source({ count = 100, max = 100, explicit = null } = {}) {
  const removed = [];
  const retained = new Map(Array.from({ length: count }, (_, id) => [id, { id, bytes: new Uint8Array(16) }]));
  const cache = { max, order: [...retained.keys()], setMaxSize(limit) {
    this.max = limit;
    while (this.order.length > this.max) {
      const id = this.order.shift(), tile = retained.get(id);
      retained.delete(id);
      removed.push(tile.id);
    }
    return this;
  } };
  return { _maxTileCacheSize: explicit, _cache: cache, _tiles: { visible: { id: 'visible' } }, removed, retained,
    updateCacheSize() { this._cache.setMaxSize(typeof this._maxTileCacheSize === 'number' ? Math.min(this._maxTileCacheSize, 100) : 100); } };
}

test('bounds dormant native tiles, preserving visible tiles and native resize behavior', () => {
  const native = source(), active = native._tiles.visible;
  const map = { style: { sourceCaches: { 'general-tiles': native } } };
  const controller = createRendererTileCacheBudget();
  controller.attach(map);
  assert.equal(native.retained.size, 64);
  assert.deepEqual(native.removed, Array.from({ length: 36 }, (_, id) => id));
  assert.strictEqual(native._tiles.visible, active);
  assert.equal(native._maxTileCacheSize, 64);
  native.updateCacheSize();
  assert.equal(native._cache.max, 64, 'native viewport updates cannot reopen the original unbounded-by-mod cache');
  assert.equal(controller.snapshot().version, RENDERER_TILE_CACHE_BUDGET_VERSION);
  assert.equal(controller.snapshot().evictedTiles, 36);
});

test('pressure evicts dormant tiles and only recovers after sustained normal samples', () => {
  const native = source();
  const map = { style: { sourceCaches: { roads: native } } };
  let now = 0;
  const controller = createRendererTileCacheBudget({ getMap: () => map, now: () => now });
  controller.updatePressure('high');
  assert.equal(native.retained.size, 16);
  assert.equal(native._maxTileCacheSize, 16);
  for (let i = 0; i < 20; i++) controller.updatePressure('normal');
  assert.equal(native._maxTileCacheSize, 16, 'an activity burst is not ten seconds of normal pressure');
  now = 9_999;
  controller.updatePressure('normal');
  assert.equal(native._cache.max, 16);
  now = 10_000;
  controller.updatePressure('normal');
  assert.equal(native._maxTileCacheSize, 64);
  assert.equal(native._cache.max, 16, 'capacity only grows when the native viewport update requests it');
  native.updateCacheSize();
  assert.equal(native._cache.max, 64);
  assert.equal(native.retained.size, 16, 'recovery increases capacity without prefetching');
  controller.updatePressure('elevated');
  assert.equal(native._cache.max, 16);
  controller.updatePressure('unavailable');
  assert.equal(native._cache.max, 16, 'missing heap data does not imply recovery');
});

test('smaller native/user limits survive pressure changes and disposal restores automatic sizing', () => {
  const automatic = source(), smaller = source({ max: 8, count: 8, explicit: 8 });
  const controller = createRendererTileCacheBudget();
  controller.attach({ style: { sourceCaches: { automatic, smaller } } });
  controller.updatePressure('high');
  assert.equal(smaller._cache.max, 8);
  assert.equal(smaller._maxTileCacheSize, 8);
  controller.dispose();
  assert.equal(automatic._maxTileCacheSize, null);
  assert.equal(automatic._cache.max, 100);
  assert.equal(smaller._maxTileCacheSize, 8);
});

test('map/style replacement and hot reload release old owners and leave live sources capped', () => {
  const oldSource = source(), newSource = source();
  const map = { style: { sourceCaches: { original: oldSource } } };
  const oldController = createRendererTileCacheBudget();
  oldController.attach(map);
  map.style.sourceCaches = { replacement: newSource };
  oldController.attach(map);
  assert.equal(oldSource._maxTileCacheSize, null);
  assert.equal(newSource._maxTileCacheSize, 64);
  const current = createRendererTileCacheBudget();
  current.attach(map);
  assert.equal(oldController.snapshot().sources.length, 0);
  assert.equal(newSource._maxTileCacheSize, 64);
  oldController.updatePressure('high');
  oldController.attach(map);
  assert.equal(newSource._maxTileCacheSize, 64, 'a retired owner cannot reattach after hot reload');
  oldController.dispose();
  assert.equal(newSource._maxTileCacheSize, 64, 'disposed old owner cannot restore the active generation limits');
  current.attach({ style: { sourceCaches: {} } });
  assert.equal(newSource._maxTileCacheSize, null);
});

test('unsupported caches and external setting changes are preserved', () => {
  const native = source(), unknown = { _cache: { max: 100, order: [] } };
  const controller = createRendererTileCacheBudget();
  controller.attach({ style: { sourceCaches: { native, unknown } } });
  assert.equal(controller.snapshot().unsupportedSources, 1);
  native._maxTileCacheSize = 4;
  native.updateCacheSize();
  controller.updatePressure('high');
  assert.equal(native._cache.max, 4);
  controller.dispose();
  assert.equal(native._maxTileCacheSize, 4);
});

test('external increases are remembered without reopening the dormant cache budget', () => {
  const native = source();
  const controller = createRendererTileCacheBudget();
  controller.attach({ style: { sourceCaches: { native } } });
  native._maxTileCacheSize = 128;
  controller.updatePressure('normal');
  native.updateCacheSize();
  assert.equal(native._maxTileCacheSize, 64);
  assert.equal(native._cache.max, 64);
  controller.dispose();
  assert.equal(native._maxTileCacheSize, 128, 'disposal preserves the later external setting');
});

test('native map removal releases cache references even before replacement or a game-end hook', () => {
  const native = source();
  const map = { style: { sourceCaches: { roads: native } } };
  const controller = createRendererTileCacheBudget({ getMap: () => map });
  controller.attach(map);
  map._removed = true;
  controller.updatePressure('normal');
  assert.equal(controller.snapshot().sources.length, 0);
  assert.equal(native._maxTileCacheSize, null);
});
