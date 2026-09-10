import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installMovementDeckVisibilityGuard,
  movementDeckGuardDiagnostics,
  MOVEMENT_DECK_GUARD_VERSION,
  GeographicContextOverlayController,
} from '../src/runtime/ui/geographic-context-overlay.js';

class Layer {
  constructor(id, data, visible = true, extra = {}) {
    this.id = id;
    this.props = { id, data, visible, ...extra };
  }

  clone(overrides) {
    const layer = new Layer(this.id, this.props.data, this.props.visible);
    layer.props = { ...this.props, ...overrides };
    layer.id = overrides.id ?? this.id;
    return layer;
  }
}

function virtualization() {
  return {
    signature: 'fixture-world',
    haloBounds: [[-180, -85, 180, 85]],
    renderInputs({ features }) { return { features }; },
  };
}

function fixture({ layers = [], revisions = null } = {}) {
  const calls = [];
  let mapBounds = [138, 35, 140, 36.5];
  let zoom = 12;
  const deck = {
    props: { layers },
    setProps(next) {
      calls.push(next);
      this.props = { ...this.props, ...next };
      return this;
    },
  };
  const map = {
    __deck: deck,
    getZoom: () => zoom,
    getBounds: () => mapBounds,
    getStyle: () => ({ layers: [] }),
  };
  const owner = { map };
  installMovementDeckVisibilityGuard(
    map,
    owner,
    virtualization,
    () => 1,
    () => revisions,
  );
  return {
    calls, deck, map, owner,
    setBounds: value => { mapBounds = value; },
    setZoom: value => { zoom = value; },
  };
}

function lineFeature(x = 139, color = 'red') {
  return {
    type: 'Feature',
    properties: { color },
    geometry: { type: 'LineString', coordinates: [[x, 35], [x + 0.1, 35.1]] },
  };
}

test('stable rail revisions reuse newly wrapped track and stopped-train layers without legacy comparisons', () => {
  const revisions = { tracks: 7, trackStyles: 2, trains: 11, trainStyles: 3, trainSimulationActive: false };
  const tracks = { type: 'FeatureCollection', features: [lineFeature()] };
  const trains = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139, 35] } }] };
  const f = fixture({ layers: [new Layer('tracks', tracks), new Layer('trains-under', trains), new Layer('trains', trains)], revisions });
  const afterAttach = movementDeckGuardDiagnostics(f.deck);

  const wrappedTracks = structuredClone(tracks);
  const wrappedTrains = structuredClone(trains);
  let stableTrainIndexReads = 0;
  wrappedTrains.features = new Proxy(wrappedTrains.features, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        stableTrainIndexReads += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  f.deck.setProps({ layers: [
    new Layer('tracks', wrappedTracks),
    new Layer('trains-under', wrappedTrains),
    new Layer('trains', wrappedTrains),
  ] });

  const afterTick = movementDeckGuardDiagnostics(f.deck);
  assert.equal(afterTick.legacyGeometryComparisons, afterAttach.legacyGeometryComparisons);
  assert.equal(afterTick.geometryCacheHits - afterAttach.geometryCacheHits, 3);
  assert.equal(afterTick.trainFeaturesProcessed - afterAttach.trainFeaturesProcessed, 0);
  assert.equal(stableTrainIndexReads, 0, 'stable train cache hits do not read selected source entries');
});

test('active train viewport cache hits defer selected source reads until revision invalidation', () => {
  const revisions = { tracks: 1, trackStyles: 1, trains: 9, trainStyles: 9, trainSimulationActive: true };
  const train = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139, 35] } };
  const initial = { type: 'FeatureCollection', features: [train] };
  const f = fixture({ layers: [new Layer('trains', initial)], revisions });
  let indexReads = 0;
  const nextFeatures = new Proxy([structuredClone(train)], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) indexReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });

  f.deck.setProps({ layers: [new Layer('trains', { type: 'FeatureCollection', features: nextFeatures })] });

  assert.equal(indexReads, 0);
  assert.equal(movementDeckGuardDiagnostics(f.deck).legacyGeometryComparisons, 0);
});

test('hidden rail layers do not traverse, compare, filter, or remove train features', () => {
  let featureReads = 0;
  const features = new Proxy([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139, 35] } }], {
    get(target, key, receiver) {
      if (key !== 'length' && key !== Symbol.iterator) featureReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const trains = { type: 'FeatureCollection', features };
  const revisions = { tracks: 1, trackStyles: 1, trains: 5, trainStyles: 1, trainSimulationActive: false };
  const f = fixture({ layers: [new Layer('trains', trains, false)], revisions });
  const afterAttach = movementDeckGuardDiagnostics(f.deck);
  f.deck.setProps({ layers: [new Layer('trains', trains, false)] });
  const afterHiddenTick = movementDeckGuardDiagnostics(f.deck);

  assert.equal(featureReads, 0);
  assert.equal(afterHiddenTick.trainFeaturesProcessed - afterAttach.trainFeaturesProcessed, 0);
  assert.equal(afterHiddenTick.legacyGeometryComparisons - afterAttach.legacyGeometryComparisons, 0);
  assert.equal(afterHiddenTick.hiddenLayerReuses - afterAttach.hiddenLayerReuses, 1);
});

test('rail revision bumps invalidate cached geometry and style while stable revisions retain rendered data', () => {
  let revisions = { tracks: 1, trackStyles: 1, trains: 1, trainStyles: 1, trainSimulationActive: true };
  const source = { type: 'FeatureCollection', features: [lineFeature()] };
  const f = fixture({ layers: [new Layer('tracks', source, true, { getColor: 'red' })], revisions });
  const firstRendered = f.deck.props.layers[0].props.data;

  source.features[0].geometry.coordinates[0][0] = 140;
  revisions = { ...revisions, tracks: 2 };
  f.deck.__openWorldMovementDeckVisibilityGuard.railRenderRevisionProvider = () => revisions;
  f.deck.setProps({ layers: [new Layer('tracks', source, true, { getColor: 'red' })] });
  const geometryRendered = f.deck.props.layers[0].props.data;
  assert.notEqual(geometryRendered, firstRendered);

  revisions = { ...revisions, trackStyles: 2 };
  const styleSource = structuredClone(source);
  styleSource.features[0].properties.color = 'blue';
  f.deck.setProps({ layers: [new Layer('tracks', styleSource, true, { getColor: 'blue' })] });
  assert.equal(f.deck.props.layers[0].props.getColor, 'blue');
  assert.equal(f.deck.props.layers[0].props.data.features[0].properties.color, 'blue');
  assert.notEqual(f.deck.props.layers[0].props.data, geometryRendered);
  assert.equal(movementDeckGuardDiagnostics(f.deck).legacyGeometryComparisons, 0);
});

test('hot reload replaces a previous-generation guard and wrapper', () => {
  const original = function setProps(next) { this.props = { ...this.props, ...next }; return this; };
  const oldWrapper = function oldWrapper() {};
  const layers = [new Layer('tracks', { type: 'FeatureCollection', features: [] })];
  const deck = { props: { layers }, setProps: oldWrapper };
  deck.__openWorldMovementDeckVisibilityGuard = {
    version: MOVEMENT_DECK_GUARD_VERSION - 1,
    nativeLayers: layers,
    originalSetProps: original,
    wrapper: oldWrapper,
    nativeOnError: null,
    owners: new Set(),
  };
  const map = { __deck: deck, getZoom: () => 12, getStyle: () => ({ layers: [] }), getBounds: () => [-1, -1, 1, 1] };
  const owner = { map };
  installMovementDeckVisibilityGuard(map, owner, virtualization, () => 1, () => ({ tracks: 1, trackStyles: 1 }));

  assert.equal(deck.__openWorldMovementDeckVisibilityGuard.version, MOVEMENT_DECK_GUARD_VERSION);
  assert.notEqual(deck.setProps, oldWrapper);
  assert.notEqual(deck.__openWorldMovementDeckVisibilityGuard.wrapper, oldWrapper);
});

test('static track buffers stay full and untouched during camera movement', () => {
  const revisions = { tracks: 1, trackStyles: 1, trains: 1, trainStyles: 1, trainSimulationActive: false };
  const tokyo = lineFeature(139);
  const osaka = lineFeature(135);
  let sourceIndexReads = 0;
  const features = new Proxy([tokyo, osaka], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) sourceIndexReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const source = { type: 'FeatureCollection', features };
  const f = fixture({ layers: [new Layer('tracks', source)], revisions });
  const renderedLayer = f.deck.props.layers[0];
  const renderedData = renderedLayer.props.data;
  assert.deepEqual(renderedData.features, [tokyo, osaka]);
  sourceIndexReads = 0;
  const beforeCamera = movementDeckGuardDiagnostics(f.deck);

  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] },
    renderDistance: 1,
    renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;
  f.setBounds([134.8, 34.8, 135.2, 35.3]);
  controller.handleMove();
  controller.handleMoveEnd();

  const afterCamera = movementDeckGuardDiagnostics(f.deck);
  assert.strictEqual(f.deck.props.layers[0], renderedLayer);
  assert.strictEqual(f.deck.props.layers[0].props.data, renderedData);
  assert.equal(sourceIndexReads, 0);
  assert.equal(afterCamera.viewportQueries, beforeCamera.viewportQueries);
});

test('camera gestures do not recull frozen visible trains', () => {
  const revisions = { tracks: 1, trackStyles: 1, trains: 4, trainStyles: 4, trainSimulationActive: false };
  const tokyo = { type: 'Feature', properties: { id: 'tokyo' }, geometry: { type: 'Point', coordinates: [139, 35] } };
  const osaka = { type: 'Feature', properties: { id: 'osaka' }, geometry: { type: 'Point', coordinates: [135, 35] } };
  const source = { type: 'FeatureCollection', features: [tokyo, osaka] };
  const f = fixture({ layers: [new Layer('trains', source)], revisions });
  const afterAttach = movementDeckGuardDiagnostics(f.deck);
  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] }, renderDistance: 1, renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;

  f.setBounds([134.8, 34.8, 135.2, 35.3]);
  controller.handleMove();
  controller.handleMoveEnd();
  for (const zoom of [9, 13, 10, 12]) {
    f.setZoom(zoom);
    controller.handleZoom();
  }

  const afterGestures = movementDeckGuardDiagnostics(f.deck);
  assert.deepEqual(f.deck.props.layers[0].props.data.features, [tokyo, osaka], 'visible frozen trains remain rendered');
  assert.equal(afterGestures.trainFeaturesProcessed, afterAttach.trainFeaturesProcessed);
  assert.equal(afterGestures.viewportQueries, afterAttach.viewportQueries);
});

test('stale active-train indexes stay idle after cached-mode and user-hidden transitions', () => {
  let revisions = { tracks: 1, trackStyles: 1, trains: 6, trainStyles: 6, trainSimulationActive: true };
  let sourceIndexReads = 0;
  const features = new Proxy([
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139, 35] } },
  ], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) sourceIndexReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const source = { type: 'FeatureCollection', features };
  const f = fixture({ layers: [new Layer('trains', source)], revisions });
  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] }, renderDistance: 1, renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;

  revisions = { ...revisions, trainSimulationActive: false };
  f.deck.__openWorldMovementDeckVisibilityGuard.railRenderRevisionProvider = () => revisions;
  // The mode transition performs one necessary restoration from the active
  // viewport subset to the full frozen train buffer.
  f.deck.setProps({ layers: [new Layer('trains', source)] });
  sourceIndexReads = 0;
  const beforeCachedMove = movementDeckGuardDiagnostics(f.deck);
  f.setBounds([135, 34, 136, 36]);
  controller.handleMove();
  assert.equal(movementDeckGuardDiagnostics(f.deck).viewportQueries, beforeCachedMove.viewportQueries);
  assert.equal(sourceIndexReads, 0);

  revisions = { ...revisions, trainSimulationActive: true };
  f.deck.setProps({ layers: [new Layer('trains', source, false)] });
  sourceIndexReads = 0;
  const beforeHiddenMove = movementDeckGuardDiagnostics(f.deck);
  controller.handleMove();
  assert.equal(movementDeckGuardDiagnostics(f.deck).viewportQueries, beforeHiddenMove.viewportQueries);
  assert.equal(sourceIndexReads, 0);
});
