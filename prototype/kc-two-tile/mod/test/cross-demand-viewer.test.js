import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCrossDemandViewer, transitLegPresentation } from '../src/ui/cross-demand-viewer.js';

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
  let mapReady;
  const api = {
    map: {
      registerSource: (id, source) => sources.push([id, source]),
      registerLayer: (layer) => layers.push(layer),
    },
    hooks: { onMapReady: (callback) => { mapReady = callback; } },
    ui: { addToolbarPanel: (definition) => { panel = definition; } },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  const controller = registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => null },
  });
  mapReady(overlayMap(sources, layers));

  assert.equal(sources.length, 2);
  assert.deepEqual(layers.map((layer) => layer.id), [
    'kc-cross-demand-connections',
    'kc-cross-demand-pop-line',
    'kc-cross-demand-points',
    'kc-cross-demand-endpoints',
  ]);
  assert.equal(panel.id, 'kc-cross-demand-viewer');
  assert.equal(panel.icon, 'UsersRound');
  assert.equal(typeof mapReady, 'function');
  assert.equal(typeof controller.attachMap, 'function');
  assert.equal('colorMode' in controller.snapshot(), false);
  assert.equal(typeof controller.setColorMode, 'undefined');
});

test('keeps demand bubbles at a constant geographic size through high zoom', () => {
  const layers = [];
  let mapReady;
  const api = {
    map: { registerSource() {}, registerLayer() {} },
    hooks: { onMapReady: (callback) => { mapReady = callback; } }, ui: { addToolbarPanel() {} },
    utils: { React: { createElement: () => null, useState: () => {}, useEffect: () => {} } },
  };
  registerCrossDemandViewer({
    api,
    runtime: { view: () => ({ activeTileId: 'KCW', gatewayLedger: {} }) },
    tilePackages: { loadCrossDemand: async () => null },
  });
  mapReady(overlayMap([], layers));

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
