import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCrossDemandViewer, transitLegPresentation } from '../src/ui/cross-demand-viewer.js';
import { createRendererVirtualization } from '../src/ui/renderer-virtualization.js';

function overlayMap(sources, layers) {
  const sourceById = new Map();
  const layerById = new Map();
  return {
    isStyleLoaded: () => true,
    getSource: (id) => sourceById.get(id),
    addSource: (id, source) => {
      const value = { ...source, setData(data) { this.data = data; } };
      sourceById.set(id, value); sources.push([id, source]);
    },
    getLayer: (id) => layerById.get(id),
    addLayer: (layer) => { layerById.set(layer.id, layer); layers.push(layer); },
    on() {}, off() {}, setLayoutProperty() {}, getCanvas: () => ({ style: {} }),
  };
}

function evaluateRadius(expression, zoom, properties) {
  if (!Array.isArray(expression)) return expression;
  const [operator, ...args] = expression;
  if (operator === 'zoom') return zoom;
  if (operator === 'get') return properties[args[0]];
  if (operator === 'case') return evaluateRadius(args[evaluateRadius(args[0], zoom, properties) ? 1 : 2], zoom, properties);
  if (operator === '*') return args.reduce((product, value) => product * evaluateRadius(value, zoom, properties), 1);
  if (operator === '^') return evaluateRadius(args[0], zoom, properties) ** evaluateRadius(args[1], zoom, properties);
  if (operator === 'interpolate') {
    const input = evaluateRadius(args[1], zoom, properties);
    const stops = args.slice(2);
    for (let index = 0; index < stops.length - 2; index += 2) {
      const leftInput = stops[index]; const leftOutput = evaluateRadius(stops[index + 1], zoom, properties);
      const rightInput = stops[index + 2]; const rightOutput = evaluateRadius(stops[index + 3], zoom, properties);
      if (input <= rightInput) {
        const base = args[0][1];
        const ratio = base === 1 ? (input - leftInput) / (rightInput - leftInput)
          : (base ** (input - leftInput) - 1) / (base ** (rightInput - leftInput) - 1);
        return leftOutput + (rightOutput - leftOutput) * ratio;
      }
    }
    return evaluateRadius(stops.at(-1), zoom, properties);
  }
  throw new Error(`Unsupported radius expression operator: ${operator}`);
}

test('presents station names and ordered route names in transit legs', () => {
  assert.deepEqual(transitLegPresentation({
    originStationId: 'station-uuid-1',
    originStationName: '42 St',
    destinationStationId: 'station-uuid-2',
    destinationStationName: '119 St',
    routes: [
      { routeId: 'route-1', label: 'A — Eighth Avenue Express' },
      { routeId: 'route-2', label: 'R — Broadway Local' },
    ],
  }), {
    stations: '42 St → 119 St',
    routes: 'A — Eighth Avenue Express → R — Broadway Local',
  });
  assert.deepEqual(transitLegPresentation({
    originStationId: 'station-uuid-1', destinationStationId: 'station-uuid-2',
  }), {
    stations: 'station-uuid-1 → station-uuid-2', routes: null,
  });
});

test('registers a native toolbar panel and map-backed cross-demand layers', () => {
  const sources = [];
  const layers = [];
  let panel;
  const api = {
    map: {
      registerSource: (id, source) => sources.push([id, source]),
      registerLayer: (layer) => layers.push(layer),
    },
    hooks: {},
    ui: { addToolbarPanel: (definition) => { panel = definition; } },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => null },
  });
  controller.attachMap(overlayMap(sources, layers));

  assert.equal(sources.length, 2);
  assert.deepEqual(layers.map((layer) => layer.id), [
    'kc-cross-demand-connections',
    'kc-cross-demand-pop-line',
    'kc-cross-demand-points',
    'kc-cross-demand-endpoints',
  ]);
  assert.equal(layers.every((layer) => layer.minzoom === 10), true);
  assert.equal(panel.id, 'kc-cross-demand-viewer');
  assert.equal(panel.icon, 'UsersRound');
  assert.equal(typeof controller.attachMap, 'function');
  assert.equal(typeof controller.detachMap, 'function');
  assert.equal('colorMode' in controller.snapshot(), false);
  assert.equal(typeof controller.setColorMode, 'undefined');
});

test('keeps demand bubbles at a constant geographic size through high zoom', () => {
  const layers = [];
  const api = {
    map: { registerSource() {}, registerLayer() {} },
    hooks: {}, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => null },
  });
  controller.attachMap(overlayMap([], layers));

  const radiusExpression = layers.find((layer) => layer.id === 'kc-cross-demand-points').paint['circle-radius'];
  const strokeExpression = layers.find((layer) => layer.id === 'kc-cross-demand-points').paint['circle-stroke-width'];
  const baseRadiusMetres = 40;
  const latitude = 39.1;
  for (const zoom of [3, 10, 13, 18, 22, 24]) {
    const nativePixelsPerMetre = 512 * 2 ** zoom / (40_030_000 * Math.cos(latitude * Math.PI / 180));
    const nativePixels = baseRadiusMetres * nativePixelsPerMetre;
    assert.ok(Math.abs(evaluateRadius(radiusExpression, zoom, { baseRadius: baseRadiusMetres }) - nativePixels) < 0.01);
    const nativeStrokePixels = 4 * nativePixelsPerMetre;
    assert.ok(Math.abs(evaluateRadius(strokeExpression, zoom, { selected: false }) - nativeStrokePixels) < 0.01);
  }
});

test('point selection replaces the global demand field with the selected point and its endpoints', async () => {
  const api = {
    map: { registerSource() {}, registerLayer() {} }, hooks: {}, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'KCW', gateways: ['central'],
      points: [
        ['home-a', -94.66, 39.1, 'KCW', 60, 0],
        ['home-b', -94.64, 39.11, 'KCW', 40, 0],
        ['work-a', -94.54, 39.1, 'KCE', 0, 60],
        ['work-b', -94.52, 39.11, 'KCE', 0, 40],
      ],
      pops: [
        ['pop-a', 60, 0, 2, 0],
        ['pop-b', 40, 1, 3, 0],
      ],
    }) },
  });
  const map = overlayMap([], []);
  controller.attachMap(map);
  await controller.open();
  assert.deepEqual(
    map.getSource('kc-cross-demand-points-source').data.features.map((feature) => feature.properties.id),
    ['home-a', 'home-b'],
  );

  controller.selectPoint('home-a');

  assert.deepEqual(
    map.getSource('kc-cross-demand-points-source').data.features.map((feature) => feature.properties.id),
    ['home-a'],
  );
  const details = map.getSource('kc-cross-demand-details-source').data.features;
  assert.deepEqual(details.map((feature) => feature.properties.kind), ['connection', 'work']);
  assert.equal(details[1].properties.view, 'per-point-endpoint');
  assert.equal(details[1].properties.id, 'work-a');
});

test('clips cross-demand dots to the live render halo', async () => {
  let haloChanged;
  let virtualization = createRendererVirtualization({
    activeTileId: 'near',
    tileCatalog: { tiles: [{ id: 'near', bounds: [-95, 39, -94, 40] }] },
    renderDistance: 1,
  });
  const rendererVirtualization = {
    getRendererVirtualization: () => virtualization,
    subscribeRenderDistance: (listener) => { haloChanged = listener; return () => {}; },
  };
  const api = {
    map: { registerSource() {}, registerLayer() {} }, hooks: {}, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'near', gatewayLedger: {} }) },
    rendererVirtualization,
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'near', gateways: ['central'],
      points: [
        ['home-near', -94.8, 39.1, 'near', 60, 0],
        ['home-far', -93.8, 39.1, 'far', 40, 0],
        ['work-far', -93.7, 39.2, 'far', 0, 60],
      ],
      pops: [['pop-near-far', 60, 0, 2, 0]],
    }) },
  });
  const map = overlayMap([], []);
  controller.attachMap(map);
  await controller.open();

  assert.deepEqual(
    map.getSource('kc-cross-demand-points-source').data.features.map((feature) => feature.properties.id),
    ['home-near'],
  );
  controller.selectPoint('home-near');
  assert.deepEqual(
    map.getSource('kc-cross-demand-details-source').data.features.map((feature) => feature.properties.kind),
    ['connection'],
  );

  virtualization = createRendererVirtualization({
    activeTileId: 'near',
    tileCatalog: { tiles: [{ id: 'near', bounds: [-95, 39, -93, 40] }] },
    renderDistance: 9,
  });
  haloChanged(9);

  assert.deepEqual(
    map.getSource('kc-cross-demand-points-source').data.features.map((feature) => feature.properties.id),
    ['home-near'],
  );
  assert.deepEqual(
    map.getSource('kc-cross-demand-details-source').data.features.map((feature) => feature.properties.kind),
    ['connection', 'work'],
  );
});

test('refreshes displayed colors and details when runtime mode share is recalculated', async () => {
  let runtimeListener;
  let crossPopModeChoices = {
    pop: { driving: 20, walking: 0, transit: 80, unknown: 0 },
  };
  let gatewayLedger = {
    flow: { flow: { homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 100 }, modeChoice: { driving: 100, walking: 0, transit: 0, unknown: 0 } },
  };
  const api = {
    map: { registerSource() {}, registerLayer() {} },
    hooks: { onMapReady() {} },
    ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: {
      view: () => ({ activeTileId: 'KCW', gatewayLedger, crossPopModeChoices }),
      subscribe: (listener) => { runtimeListener = listener; return () => {}; },
    },
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'KCW', gateways: ['central'],
      points: [['home', -94.66, 39.1, 'KCW', 100, 0], ['work', -94.54, 39.1, 'KCE', 0, 100]],
      pops: [['pop', 100, 0, 1, 0]],
    }) },
  });
  await controller.open();
  controller.selectPoint('home');
  assert.deepEqual(controller.pointDetails().modeChoice,
    { driving: 20, walking: 0, transit: 80 });

  gatewayLedger = {
    flow: { flow: { homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 100 }, modeChoice: { driving: 40, walking: 0, transit: 60, unknown: 0 } },
  };
  crossPopModeChoices = {
    pop: { driving: 70, walking: 0, transit: 30, unknown: 0 },
  };
  runtimeListener({ type: 'cross-mode-share' });
  assert.deepEqual(controller.pointDetails().modeChoice,
    { driving: 70, walking: 0, transit: 30 });
});

test('adds current transit-path diagnostics to the selected pop', async () => {
  const expectedPath = { available: true, totalSeconds: 1_800, homeLeg: {}, workLeg: {} };
  const api = {
    map: { registerSource() {}, registerLayer() {} },
    hooks: { onMapReady() {} },
    ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const runtime = {
    view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }),
    inspectCrossTileTransitPath: (_data, popIndex) => {
      assert.equal(popIndex, 0);
      return expectedPath;
    },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime,
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'KCW', gateways: ['central'],
      points: [['home', -94.66, 39.1, 'KCW', 50, 0], ['work', -94.54, 39.1, 'KCE', 0, 50]],
      pops: [['pop', 50, 0, 1, 0]],
    }) },
  });

  await controller.open();
  controller.selectPop(0);
  assert.equal(controller.popDetails().transitPath, expectedPath);
});

test('adds driving and generalized-cost diagnostics to the selected pop', async () => {
  const expectedComparison = {
    driving: { clockSeconds: 1_200, perceivedSeconds: 2_100, distanceMetres: 10_000, moneyCost: 11.5 },
    transit: { clockSeconds: 1_500, perceivedSeconds: 1_700, moneyCost: 2.5 },
  };
  const api = {
    map: { registerSource() {}, registerLayer() {} }, hooks: { onMapReady() {} }, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const runtime = {
    view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }),
    inspectCrossTileTransitPath: () => ({ available: true, totalSeconds: 1_700 }),
    inspectCrossTileModeChoice: () => expectedComparison,
  };
  const controller = registerCrossDemandViewer({
    api, runtime,
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'KCW', gateways: ['central'],
      points: [['home', -94.66, 39.1, 'KCW', 50, 0], ['work', -94.54, 39.1, 'KCE', 0, 50]],
      pops: [['pop', 50, 0, 1, 0]],
    }) },
  });

  await controller.open();
  controller.selectPop(0);
  assert.equal(controller.popDetails().modeChoiceComparison, expectedComparison);
});

test('selected cross pops replace the geometric line with the shared asynchronous road path', async () => {
  const api = {
    map: { registerSource() {}, registerLayer() {} }, hooks: {}, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const roadPath = [[-94.66, 39.1], [-94.61, 39.12], [-94.54, 39.1]];
  const routeCalls = [];
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => ({
      schemaVersion: 1, tileId: 'KCW', gateways: ['central'],
      points: [['home', -94.66, 39.1, 'KCW', 50, 0], ['work', -94.54, 39.1, 'KCE', 0, 50]],
      pops: [['nec-cross-pop-1', 50, 0, 1, 0]],
    }) },
    routePaths: { resolve: async (city, popId) => {
      routeCalls.push([city, popId]);
      return { coordinates: roadPath, source: 'generated-road-graph' };
    } },
  });
  const map = overlayMap([], []);
  controller.attachMap(map);
  await controller.open();
  controller.selectPop(0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(routeCalls, [['KCW', 'nec-cross-pop-1']]);
  assert.equal(controller.snapshot().routeStatus, 'generated-road-graph');
  assert.deepEqual(map.getSource('kc-cross-demand-details-source').data.features[0].geometry.coordinates, roadPath);
});
