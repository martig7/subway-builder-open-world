import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCrossDemandViewer } from '../../../../open-world-platform/src/runtime/ui/cross-demand-viewer.js';
import { registerNetworkProjectionOverlay } from '../../../../open-world-platform/src/runtime/ui/network-projection-overlay.js';

function fixtureMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    sources, layers,
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, definition) => sources.set(id, { ...definition, setData(data) { this.data = data; } }),
    getLayer: (id) => layers.get(id),
    addLayer: (definition) => layers.set(definition.id, definition),
    on() {}, off() {}, setLayoutProperty() {}, getCanvas: () => ({ style: {} }),
  };
}

function fixtureApi() {
  const replayRegistrations = [];
  let mapReady;
  return {
    replayRegistrations,
    api: {
      map: {
        registerSource: (...args) => replayRegistrations.push(['source', ...args]),
        registerLayer: (...args) => replayRegistrations.push(['layer', ...args]),
      },
      hooks: { onMapReady: (callback) => { mapReady = callback; } },
      ui: { addToolbarPanel() {} },
      utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
    },
    fireMapReady: (map) => mapReady?.(map),
  };
}

test('cross-demand artifacts are owned by the live map instead of the API replay registry', () => {
  const fixture = fixtureApi();
  const controller = registerCrossDemandViewer({
    api: fixture.api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => null },
  });
  const map = fixtureMap();
  controller.attachMap(map);

  assert.deepEqual(fixture.replayRegistrations, []);
  assert.equal(map.sources.size, 2);
  assert.equal(map.layers.size, 4);
  controller.detachMap();
  assert.equal(controller.map, null);
});

test('network-projection artifacts are owned by the live map instead of the API replay registry', () => {
  const fixture = fixtureApi();
  const controller = registerNetworkProjectionOverlay({
    api: fixture.api,
    runtime: { projectionOverlay: () => ({ type: 'FeatureCollection', features: [] }), subscribe: () => () => {} },
  });
  const map = fixtureMap();
  controller.attachMap(map);

  assert.deepEqual(fixture.replayRegistrations, []);
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 2);
  controller.detachMap();
  assert.equal(controller.map, null);
});
