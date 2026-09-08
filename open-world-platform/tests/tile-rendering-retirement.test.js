import test from 'node:test';
import assert from 'node:assert/strict';
import { armTileRenderingRetirement } from '../src/runtime/tile-rendering-retirement.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';

function fixture({ reset = true, fail = false } = {}) {
  const feature = { geometry: { coordinates: [[1, 2], [3, 4]] } };
  const collection = () => ({ type: 'FeatureCollection', features: [feature] });
  const root = { leaf: false, children: [{ leaf: true, children: [feature] }] };
  const roads = collection(), runways = collection();
  const index = { data: root, clear() { this.data = { leaf: true, children: [] }; } };
  const attribute = { value: new Float32Array(16), state: { allocatedValue: new Float32Array(16) } };
  const layer = { id: 'road-lines-major', lifecycle: 'Matched', props: { data: collection() },
    state: { features: [feature] }, internalState: { attributeManager: { attributes: { positions: attribute } } } };
  const manager = { getLayers: () => [layer] };
  const deck = { props: { layers: [layer] }, layerManager: manager };
  let onRemove;
  const map = { __deck: deck, once(event, fn) { assert.equal(event, 'remove'); onRemove = fn; } };
  const queue = [], reports = [];
  const finance = [{ money: 123 }], tracks = [{ id: 'rail' }];
  let state = { roadsGeojson: roads, runwaysTaxiwaysGeojson: runways, roadsIndex: index,
    financialHistory: finance, tracks, setTimeConfig() {} };
  const original = function(city) {
    assert.equal(this, state);
    if (fail) throw Error('load failed before reset');
    if (reset) state = { ...state, cityCode: city, roadsGeojson: collection(), roadsIndex: { data: {} }, runwaysTaxiwaysGeojson: collection() };
    return promise;
  };
  const promise = Promise.resolve('loaded');
  state.loadInitialData = original;
  return { roads, runways, root, index, feature, attribute, layer, deck, map, queue, reports, original, promise,
    options: { getState: () => state, getMap: () => map._removed ? { __deck: {} } : map,
      targetCity: 'NEXT', schedule: fn => queue.push(fn), onReport: r => reports.push(r) },
    remove() { map._removed = true; deck.layerManager = null; layer.lifecycle = 'Finalized! Awaiting garbage collection'; onRemove?.(); queue.splice(0).forEach(fn => fn()); },
    state: () => state, finance, tracks };
}

function detectorFixture() {
  const payload = new Float64Array([7, 8]);
  return {
    buildingCount: 2, cols: 1, rows: 1,
    forEachBuildingInCell: (_x, _y, visit) => payload.forEach((_value, index) => visit(index)),
    getBoundsMinX: i => payload[i], getBoundsMinY: i => payload[i],
    getBoundsMaxX: i => payload[i], getBoundsMaxY: i => payload[i],
    getFoundationDepth: i => payload[i], getHeight: i => payload[i],
    getOsmIds: i => [payload[i]], getBuilding: i => ({ polygon: [[payload[i]]] }),
  };
}

test('pre-navigation retirement replaces the old building detector closures without touching native saves', () => {
  const f = fixture(), detector = detectorFixture();
  f.state().buildingDetector = detector;
  const original = detector.getBuilding;
  const guard = armTileRenderingRetirement(f.options);
  assert.equal(detector.getBuilding, original, 'arming alone must preserve construction');
  guard.retireBeforeNavigation();
  assert.notEqual(detector.getBuilding, original);
  assert.equal(detector.buildingCount, 0);
  assert.equal(detector.cols, 0);
  assert.equal(detector.rows, 0);
  detector.forEachBuildingInCell(0, 0, () => assert.fail('retired geography was queried'));
  assert.deepEqual(detector.getBuilding(0).polygon, []);
  assert.equal(f.reports.at(-1).buildings, 2);
  assert.equal(f.state().tracks, f.tracks);
  assert.equal(f.state().financialHistory, f.finance);
});

test('fallback loading preserves a detector still used by the current city', () => {
  const f = fixture({ reset: false }), detector = detectorFixture();
  f.state().buildingDetector = detector;
  const original = detector.getBuilding;
  armTileRenderingRetirement(f.options);
  f.state().loadInitialData('NEXT');
  assert.equal(detector.getBuilding, original);
  assert.equal(detector.buildingCount, 2);
});

test('unknown or frozen detector implementations are not partially retired', () => {
  for (const detector of [Object.freeze(detectorFixture()), { ...detectorFixture(), customQuery() {} }]) {
    const f = fixture(), original = detector.getBuilding;
    f.state().buildingDetector = detector;
    armTileRenderingRetirement(f.options).retireBeforeNavigation();
    assert.equal(detector.getBuilding, original);
    assert.equal(detector.buildingCount, 2);
    assert.deepEqual(f.reports.at(-1).errors, []);
  }
});

test('adapter arms retirement without clearing the still-active city', () => {
  const f = fixture();
  const game = new SubwayBuilderGameAdapter({ api: { utils: { getMap: f.options.getMap } }, callbacks: { getState: f.options.getState } });
  game.prepareTileRenderingRetirement('NEXT');
  assert.notEqual(f.state().loadInitialData, f.original);
  assert.equal(f.roads.features.length, 1);
});

test('releases independently retained geometry/index roots after reset and finalized layer buffers after remove', async () => {
  const f = fixture(), oldFeatures = f.roads.features, oldLeaf = f.root.children[0], oldLayerData = f.layer.props.data;
  armTileRenderingRetirement(f.options);
  assert.equal(f.state().loadInitialData('NEXT'), f.promise);
  assert.equal(oldFeatures.length, 0);
  assert.equal(oldLeaf.children.length, 0);
  assert.equal(f.root.children.length, 0);
  assert.equal(f.state().roadsGeojson.features.length, 1);
  assert.equal(f.state().financialHistory, f.finance);
  assert.equal(f.state().tracks, f.tracks);
  assert.equal(f.attribute.value.byteLength, 64);
  f.remove();
  assert.equal(f.attribute.value, null);
  assert.equal(f.attribute.state.allocatedValue, null);
  assert.equal(oldLayerData.features.length, 0);
  assert.deepEqual(f.deck.props.layers, []);
  assert.equal(f.reports.at(-1).rendererReleased, true);
  assert.equal(f.state().loadInitialData, f.original);
});

test('cancelled and unrelated navigation preserve rendering data', () => {
  const f = fixture();
  const guard = armTileRenderingRetirement(f.options); guard.cancel();
  assert.equal(f.state().loadInitialData, f.original);
  assert.equal(f.roads.features.length, 1);
  armTileRenderingRetirement(f.options);
  f.state().loadInitialData('ELSEWHERE');
  assert.equal(f.roads.features.length, 1);
  assert.equal(f.reports.length, 0);
});

test('a throw or native load that keeps the old resources does not empty active data', () => {
  const throwing = fixture({ fail: true }); armTileRenderingRetirement(throwing.options);
  assert.throws(() => throwing.state().loadInitialData('NEXT'), /before reset/);
  assert.equal(throwing.roads.features.length, 1);
  const same = fixture({ reset: false }); armTileRenderingRetirement(same.options);
  same.state().loadInitialData('NEXT');
  assert.equal(same.roads.features.length, 1);
  assert.equal(same.root.children.length, 1);
});

test('rearming replaces a previous wrapper without chaining closures', () => {
  const f = fixture(); const first = armTileRenderingRetirement(f.options), old = f.state().loadInitialData;
  const second = armTileRenderingRetirement(f.options);
  assert.equal(first.armed, false); assert.equal(second.armed, true);
  assert.notEqual(f.state().loadInitialData, old);
  second.cancel(); assert.equal(f.state().loadInitialData, f.original);
});

test('native getMap can still return the removed map while teardown completes', () => {
  const f = fixture();
  armTileRenderingRetirement({ ...f.options, getMap: () => f.map });
  f.state().loadInitialData('NEXT'); f.remove();
  assert.equal(f.reports.at(-1).rendererReleased, true);
  assert.equal(f.attribute.value, null);
});

test('captures finalized layers from Deck props when native removed the manager before loading', () => {
  const f = fixture();
  f.map._removed = true; f.deck.layerManager = null;
  f.layer.lifecycle = 'Finalized! Awaiting garbage collection';
  armTileRenderingRetirement({ ...f.options, getMap: () => f.map });
  f.state().loadInitialData('NEXT'); f.queue.splice(0).forEach(fn => fn());
  assert.equal(f.reports.at(-1).roadLayers, 1);
  assert.equal(f.attribute.value, null);
});

test('validated navigation retires roads before native loading allocates the next city', () => {
  const f = fixture();
  const guard = armTileRenderingRetirement(f.options);
  guard.retireBeforeNavigation();
  assert.equal(f.roads.features.length, 0);
  assert.equal(f.root.children.length, 0);
  assert.equal(f.state().financialHistory, f.finance);
  assert.equal(f.state().tracks, f.tracks);
  f.state().loadInitialData('NEXT');
  assert.equal(f.state().roadsGeojson.features.length, 1);
  f.remove();
  assert.equal(f.reports.at(-1).roadLayers, 1);
});

test('replaces a retained previous-generation load patch with its original native action', () => {
  const f = fixture(); let cancelled = false;
  const previous = () => { throw Error('old generation ran'); };
  const oldPatch = { version: 'tile-rendering-retirement-v3', original: f.original,
    cancel() { cancelled = true; f.state().loadInitialData = f.original; } };
  previous.__openWorldTileRenderingRetirement = oldPatch;
  f.state().loadInitialData = previous;
  armTileRenderingRetirement(f.options);
  assert.equal(cancelled, true);
  assert.notEqual(f.state().loadInitialData, previous);
  assert.notEqual(f.state().loadInitialData.__openWorldTileRenderingRetirement, oldPatch);
  assert.equal(f.state().loadInitialData('NEXT'), f.promise);
  assert.equal(f.state().loadInitialData, f.original);
});

test('missing native loading capability leaves navigation cleanup inert', () => {
  const guard = armTileRenderingRetirement({ getState: () => ({}), getMap: () => null, targetCity: 'NEXT' });
  assert.equal(guard.armed, false);
  assert.doesNotThrow(() => { guard.retireBeforeNavigation(); guard.cancel(); });
});
