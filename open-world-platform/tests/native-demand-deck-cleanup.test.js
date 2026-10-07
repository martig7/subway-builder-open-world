import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossDemandOverlayController } from '../src/runtime/ui/cross-demand-viewer.js';
import { syncCityScopedMapControllers } from '../src/runtime/ui/city-scoped-map-controllers.js';
import {
  appendCrossDemandDeckLayer, NativeDemandDeckOverlay,
  CROSS_DEMAND_DECK_LAYER, NATIVE_DEMAND_DECK_CLEANUP_VERSION,
} from '../src/runtime/ui/native-demand-deck.js';

const OWNER = Symbol.for('open-world.cross-demand-deck');

function fixtureMap() {
  const layers = new Map(), handlers = new Set(), removedLayers = [], submissions = [];
  const nativeLayers = [{ id: 'demand-points' }];
  const guard = { nativeLayers };
  const map = {
    style: { getLayer: id => layers.get(id) },
    getLayer(id) { return this.style.getLayer(id); },
    removeLayer(id) { removedLayers.push(id); layers.delete(id); },
    isStyleLoaded: () => false,
    on(type, ...args) { handlers.add(args.at(-1)); },
    off(type, ...args) { handlers.delete(args.at(-1)); },
    __deck: {
      __openWorldMovementDeckVisibilityGuard: guard,
      setProps(props) { submissions.push(props); },
    },
  };
  return { map, layers, handlers, removedLayers, submissions, nativeLayers, guard };
}

for (const removed of [true, false]) {
  test(`map-ready controller chain survives a destroyed style with _removed=${removed}`, () => {
    const old = fixtureMap(), next = fixtureMap();
    const demand = new CrossDemandOverlayController({ api: {}, runtime: {}, tilePackages: {} });
    const laterMaps = [];
    const controllers = [demand, { attachMap(map) { laterMaps.push(map); } }];
    const attach = map => syncCityScopedMapControllers({
      map, cityCode: 'JP_PREF_28', cityCodes: ['JP_PREF_28'], controllers,
    });
    attach(old.map);
    assert.equal(globalThis.__openWorldNativeDemandDeckCleanupVersion, NATIVE_DEMAND_DECK_CLEANUP_VERSION);
    assert.equal(old.map[OWNER], demand.nativeOverlay);
    const submissionsBeforeRemoval = old.submissions.length;
    delete old.map.style;
    old.map._removed = removed;
    old.map.__deck.setProps = () => { throw new Error('destroyed deck must not be updated'); };

    assert.doesNotThrow(() => attach(next.map));
    assert.deepEqual(laterMaps, [old.map, next.map], 'cleanup must not abort later map-ready controllers');
    assert.equal(demand.map, next.map);
    assert.equal(demand.nativeOverlay.map, next.map);
    assert.equal(old.map[OWNER], undefined, 'release the retired map owner');
    assert.equal(old.handlers.size, 0, 'release event handlers from the retired map');
    assert.equal(old.submissions.length, submissionsBeforeRemoval);
    assert.equal(old.map.__deck.__openWorldMovementDeckVisibilityGuard, old.guard);
    assert.equal(old.guard.nativeLayers, old.nativeLayers, 'cleanup preserves retained native Deck inputs');
    demand.dispose();
  });
}

test('removed maps with a retained style skip style and Deck access and release cached overlay state', () => {
  const s = fixtureMap();
  const overlay = new NativeDemandDeckOverlay({ api: {} });
  overlay.attachMap(s.map);
  overlay.drawLayer = {};
  overlay.layer = { stale: true };
  overlay.key = 'stale';
  overlay.data = [{ stale: true }];
  s.map._removed = true;
  s.map.getLayer = () => { throw new Error('removed style must not be inspected'); };
  Object.defineProperty(s.map, '__deck', { get() { throw new Error('removed deck must not be inspected'); } });

  assert.doesNotThrow(() => overlay.detachMap());
  assert.equal(s.map[OWNER], undefined);
  assert.equal(overlay.map, null);
  assert.equal(overlay.drawLayer, null);
  assert.equal(overlay.layer, null);
  assert.equal(overlay.key, null);
  assert.deepEqual(overlay.data, []);
});

test('late overlay refresh, idle, picking and shared-guard composition skip a destroyed style', () => {
  const s = fixtureMap();
  const overlay = new NativeDemandDeckOverlay({ api: {} });
  overlay.attachMap(s.map);
  overlay.active = true;
  overlay.data = [{ properties: { population: 500 } }];
  overlay.layer = { stale: true };
  overlay.key = 'stale';
  delete s.map.style;
  Object.defineProperty(s.map, '__deck', { get() { throw new Error('destroyed deck must not be inspected'); } });
  const renderedLayers = [{ id: 'retained-native-layer' }];

  assert.doesNotThrow(() => overlay.refresh());
  assert.doesNotThrow(() => overlay.ensureDrawLayer());
  assert.equal(overlay.pick({ x: 100, y: 100 }), undefined);
  assert.equal(appendCrossDemandDeckLayer(s.map, s.nativeLayers, renderedLayers), renderedLayers);
  assert.equal(overlay.layer, null);
  assert.equal(overlay.key, null);
  overlay.detachMap();
});

test('live-map cleanup removes only its own draw layer and restores native Deck inputs', () => {
  const s = fixtureMap();
  const overlay = new NativeDemandDeckOverlay({ api: {} });
  overlay.attachMap(s.map);
  const drawLayer = { id: CROSS_DEMAND_DECK_LAYER };
  s.layers.set(CROSS_DEMAND_DECK_LAYER, { implementation: drawLayer });
  overlay.drawLayer = drawLayer;
  overlay.detachMap();
  assert.deepEqual(s.removedLayers, [CROSS_DEMAND_DECK_LAYER]);
  assert.equal(s.layers.has(CROSS_DEMAND_DECK_LAYER), false);
  assert.equal(s.submissions.at(-1).layers, s.nativeLayers);
  assert.equal(s.map.__deck.__openWorldMovementDeckVisibilityGuard, s.guard);

  overlay.attachMap(s.map);
  const foreignLayer = { id: CROSS_DEMAND_DECK_LAYER };
  s.layers.set(CROSS_DEMAND_DECK_LAYER, foreignLayer);
  overlay.drawLayer = drawLayer;
  overlay.detachMap();
  assert.equal(s.layers.get(CROSS_DEMAND_DECK_LAYER), foreignLayer);
  assert.deepEqual(s.removedLayers, [CROSS_DEMAND_DECK_LAYER]);
});

test('live-map removal failures still propagate and release the overlay references', () => {
  const s = fixtureMap();
  const overlay = new NativeDemandDeckOverlay({ api: {} });
  overlay.attachMap(s.map);
  overlay.drawLayer = { id: CROSS_DEMAND_DECK_LAYER };
  s.layers.set(CROSS_DEMAND_DECK_LAYER, overlay.drawLayer);
  const failure = new Error('native layer removal failed');
  s.map.removeLayer = () => { throw failure; };
  assert.throws(() => overlay.detachMap(), error => error === failure);
  assert.equal(overlay.map, null);
  assert.equal(overlay.drawLayer, null);
  assert.equal(s.map[OWNER], undefined);
});

test('a hot-reloaded overlay replaces the previous owner and retains the shared Deck guard', () => {
  const s = fixtureMap();
  const previous = new NativeDemandDeckOverlay({ api: {} });
  previous.attachMap(s.map);
  previous.drawLayer = { id: CROSS_DEMAND_DECK_LAYER };
  s.layers.set(CROSS_DEMAND_DECK_LAYER, previous.drawLayer);
  previous.layer = { stale: true };
  previous.key = 'previous-generation';
  const wrapper = s.map.__deck.setProps;
  const current = new NativeDemandDeckOverlay({ api: {} });
  current.attachMap(s.map);
  assert.equal(previous.map, null);
  assert.equal(previous.layer, null);
  assert.equal(previous.drawLayer, null);
  assert.equal(previous.key, null);
  assert.equal(s.map[OWNER], current);
  assert.equal(s.map.__deck.setProps, wrapper, 'overlay ownership does not add a Deck wrapper');
  assert.equal(s.map.__deck.__openWorldMovementDeckVisibilityGuard, s.guard);
  assert.deepEqual(s.removedLayers, [CROSS_DEMAND_DECK_LAYER]);
  previous.detachMap();
  assert.equal(s.map[OWNER], current, 'disposal of the old instance cannot detach its replacement');
  current.detachMap();
});
