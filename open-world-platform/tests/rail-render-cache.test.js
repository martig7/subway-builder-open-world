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

test('paused camera movement expands the indexed presentation before leaving its padding', () => {
  const revisions = { tracks: 1, trackStyles: 1, trains: 1, trainStyles: 1, trainSimulationActive: false };
  const tokyo = lineFeature(139);
  const osaka = lineFeature(135);
  const source = { type: 'FeatureCollection', features: [tokyo, osaka] };
  const f = fixture({ layers: [new Layer('tracks', source)], revisions });
  assert.deepEqual(f.deck.props.layers[0].props.data.features, [tokyo]);

  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] },
    renderDistance: 1,
    renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;
  f.setBounds([134.8, 34.8, 135.2, 35.3]);
  controller.handleMove();

  assert.deepEqual(f.deck.props.layers[0].props.data.features, [osaka]);
  const diagnostics = movementDeckGuardDiagnostics(f.deck);
  assert.equal(diagnostics.indexBuilds, 1, 'camera movement queries the retained spatial index');
  assert.ok(diagnostics.viewportCandidatesVisited <= 2);
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

test('track chunks retain existing Deck layer and data identities as the camera adds nearby chunks', () => {
  let revisions = { tracks: 3, trackStyles: 3, trains: 1, trainStyles: 1, trainSimulationActive: false };
  const near = lineFeature(139);
  const entering = lineFeature(141.5);
  const source = { type: 'FeatureCollection', features: [near, entering] };
  const f = fixture({ layers: [new Layer('tracks', source, true, { pickable: false, beforeId: 'labels' })], revisions });
  const initialChunks = f.deck.props.layers.flat(Infinity);
  assert.equal(initialChunks.length, 1);
  assert.match(initialChunks[0].id, /^tracks-open-world-chunk-/);
  assert.equal(initialChunks[0].props.beforeId, 'labels');
  const retainedLayer = initialChunks[0];
  const retainedData = retainedLayer.props.data;

  f.deck.setProps({ layers: [new Layer('tracks', structuredClone(source), true, {
    pickable: false, beforeId: 'labels', getLineColor: () => [1, 2, 3],
    updateTriggers: { getLineColor: [3] },
  })] });
  const refreshedAccessorLayer = f.deck.props.layers.flat(Infinity)[0];
  assert.notStrictEqual(refreshedAccessorLayer, retainedLayer);
  assert.strictEqual(refreshedAccessorLayer.props.data, retainedData,
    'accessor wrapper churn retains stable chunk data');
  f.deck.setProps({ layers: [new Layer('tracks', structuredClone(source), true, {
    pickable: false, beforeId: 'labels', getLineColor: () => [1, 2, 3],
    updateTriggers: { getLineColor: [3] },
  })] });
  assert.strictEqual(f.deck.props.layers.flat(Infinity)[0], refreshedAccessorLayer,
    'equivalent update triggers retain the chunk layer across regenerated accessors');

  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] }, renderDistance: 1, renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;
  f.setBounds([140, 35, 142, 36.5]);
  controller.handleMove();
  const expandedChunks = f.deck.props.layers.flat(Infinity);

  assert.equal(expandedChunks.length, 2);
  assert.ok(expandedChunks.includes(refreshedAccessorLayer));
  assert.strictEqual(expandedChunks.find(layer => layer === refreshedAccessorLayer).props.data, retainedData);
  assert.equal(movementDeckGuardDiagnostics(f.deck).trackChunkBuilds, 1);

  f.setBounds([142, 35, 144, 36.5]);
  controller.handleMove();
  const maskedOffscreenLayer = f.deck.props.layers.flat(Infinity)
    .find(layer => layer.id === refreshedAccessorLayer.id);
  assert.ok(maskedOffscreenLayer, 'constructed offscreen chunks remain in the Deck tree');
  assert.equal(maskedOffscreenLayer.props.visible, false);
  assert.strictEqual(maskedOffscreenLayer.props.data, retainedData);
  assert.equal(f.deck.props.layers.flat(Infinity).length, 2, 'camera movement does not drop constructed chunks');
  f.setBounds([138, 35, 140, 36.5]);
  controller.handleMove();
  const reenteredLayer = f.deck.props.layers.flat(Infinity)
    .find(layer => layer.props.data.features.includes(near));
  assert.equal(reenteredLayer.id, refreshedAccessorLayer.id);
  assert.equal(reenteredLayer.props.visible, true);
  assert.strictEqual(reenteredLayer.props.data, retainedData);

  f.deck.setProps({ layers: [new Layer('tracks', source, false, { pickable: false, beforeId: 'labels' })] });
  f.deck.setProps({ layers: [new Layer('tracks', source, true, { pickable: false, beforeId: 'labels' })] });
  const revealedLayer = f.deck.props.layers.flat(Infinity)[0];
  assert.notStrictEqual(revealedLayer, reenteredLayer,
    'a chunk finalized while hidden is not reused on reveal');
  assert.strictEqual(revealedLayer.props.data, retainedData);

  revisions = { ...revisions, trackStyles: 4 };
  f.deck.__openWorldMovementDeckVisibilityGuard.railRenderRevisionProvider = () => revisions;
  const styled = structuredClone(source);
  styled.features[0].properties.color = 'blue';
  f.deck.setProps({ layers: [new Layer('tracks', styled, true, { pickable: false, beforeId: 'labels' })] });
  const styledChunks = f.deck.props.layers.flat(Infinity);
  assert.ok(styledChunks.every(layer => !expandedChunks.includes(layer)));
  assert.equal(styledChunks[0].props.data.features[0].properties.color, 'blue');
});

test('track visibility mask bounds dormant retained chunks', () => {
  const revisions = { tracks: 8, trackStyles: 8, trains: 1, trainStyles: 1, trainSimulationActive: false };
  const features = Array.from({ length: 70 }, (_, index) => lineFeature(index - 30));
  const source = { type: 'FeatureCollection', features };
  const f = fixture({ layers: [new Layer('tracks', source, true, { pickable: false })], revisions });
  const controller = new GeographicContextOverlayController({
    tileCatalog: { id: 'fixture', tiles: [] }, renderDistance: 1, renderDistanceStorage: null,
  });
  controller.map = f.map;
  controller.movementDeck = f.deck;

  for (let index = 0; index < features.length; index += 1) {
    const longitude = index - 30;
    f.setBounds([longitude - 0.05, 34.9, longitude + 0.05, 35.2]);
    controller.handleMove();
  }

  const retained = f.deck.props.layers.flat(Infinity);
  assert.ok(retained.length <= 65, `${retained.length} active+dormant chunks were retained`);
  assert.ok(retained.filter(layer => layer.props.visible === false).length <= 64);
});
