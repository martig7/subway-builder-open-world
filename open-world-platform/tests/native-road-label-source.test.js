import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoadLabelData, createNativeRoadLabelSourceGuard, NATIVE_ROAD_LABEL_SOURCE_VERSION } from '../src/runtime/native-road-label-source.js';

const road = (id, name) => ({ type: 'Feature', id, properties: { name, roadClass: 'primary' },
  geometry: { type: 'LineString', coordinates: [[139, 35], [140, 36]] } });
const collection = (...features) => ({ type: 'FeatureCollection', features });
function fixture() {
  class Map {
    constructor() { this.sources = {}; this.layers = []; this.loads = []; }
    getStyle() { return { layers: this.layers }; }
    getSource(id) { return this.sources[id]; }
    addSource(id, spec) {
      this.loads.push(spec.data);
      this.sources[id] = { type: spec.type, map: this, _data: spec.data,
        onRemove() { this._removed = true; },
        setData(data) { this._data = data; this.map.loads.push(data); return this; } };
      return this;
    }
  }
  return Map;
}

test('drops only invisible names, preserving exact named feature identity, order and geometry', () => {
  const named = [road(1, '国道'), road(2, ' '), road(3, 0)];
  const input = collection(road(4, null), named[0], road(5, ''), named[1], road(6), named[2]);
  const output = compactRoadLabelData(input);
  assert.deepEqual(output.features, named);
  named.forEach((feature, index) => assert.equal(output.features[index], feature));
  assert.equal(input.features.length, 6);
  assert.equal(compactRoadLabelData(output), output);
  assert.equal(compactRoadLabelData('roads.json'), 'roads.json');
});

test('compacts the initial worker load and later setData without altering native data', () => {
  const Map = fixture(), first = new Map(), next = new Map();
  const reports = [];
  const guard = createNativeRoadLabelSourceGuard({ isEnabled: () => true, onReport: r => reports.push(r) });
  guard.attach(first);
  const input = collection(road(1), road(2, 'A'));
  assert.equal(next.addSource('roads-source', { type: 'geojson', data: input }), next);
  assert.deepEqual(next.loads.map(data => data.features.length), [1]);
  const source = next.getSource('roads-source');
  assert.equal(source.setData(input), source);
  assert.deepEqual(next.loads.map(data => data.features.length), [1, 1]);
  assert.equal(input.features.length, 2);
  assert.equal(reports.at(-1).version, NATIVE_ROAD_LABEL_SOURCE_VERSION);
  guard.dispose();
  source.setData(input);
  assert.equal(source._data, input);
});

test('attaches to an existing source and handles replacement maps without retaining their data', () => {
  const Map = fixture(), map = new Map();
  const data = collection(road(1), road(2, 'A'));
  map.addSource('roads-source', { type: 'geojson', data });
  const guard = createNativeRoadLabelSourceGuard({ isEnabled: () => true });
  guard.attach(map);
  guard.attach(map);
  assert.deepEqual(map.loads.map(value => value.features.length), [2, 1]);
  guard.dispose();
});

test('leaves unrelated sources, worlds, and non-label consumers untouched', () => {
  const Map = fixture(), map = new Map();
  let enabled = false;
  const guard = createNativeRoadLabelSourceGuard({ isEnabled: () => enabled });
  guard.attach(map);
  const data = collection(road(1));
  map.addSource('roads-source', { type: 'geojson', data });
  assert.equal(map.loads.at(-1), data);
  enabled = true;
  map.addSource('other-roads', { type: 'geojson', data });
  assert.equal(map.loads.at(-1), data);
  map.layers.push({ id: 'road-lines', type: 'line', source: 'roads-source' });
  map.getSource('roads-source').setData(data);
  assert.equal(map.loads.at(-1), data);
  guard.dispose();
});

test('drops the filtered array only after native source removal', () => {
  const Map = fixture(), map = new Map();
  const guard = createNativeRoadLabelSourceGuard({ isEnabled: () => true });
  guard.attach(map);
  const data = collection(road(1), road(2, 'A'));
  map.addSource('roads-source', { type: 'geojson', data });
  const source = map.getSource('roads-source');
  assert.equal(source._data.features.length, 1);
  source.onRemove();
  assert.equal(source._removed, true);
  assert.equal(source._data.features.length, 0);
  assert.equal(data.features.length, 2);
  guard.dispose();
});

test('replaces the previous patch generation and native wrapper, then restores the original', () => {
  const Map = fixture(), map = new Map(), native = Map.prototype.addSource;
  let disposed = false;
  const oldWrapper = function (...args) { return native.apply(this, args); };
  const previous = { version: 'native-road-label-source-v1', wrapper: oldWrapper,
    dispose() { disposed = true; Map.prototype.addSource = native; delete Map.prototype.__openWorldNativeRoadLabelSource; } };
  Map.prototype.addSource = oldWrapper;
  Map.prototype.__openWorldNativeRoadLabelSource = previous;
  const guard = createNativeRoadLabelSourceGuard({ isEnabled: () => true });
  guard.attach(map);
  assert.equal(disposed, true);
  assert.notEqual(Map.prototype.__openWorldNativeRoadLabelSource, previous);
  assert.notEqual(Map.prototype.addSource, oldWrapper);
  guard.dispose();
  assert.equal(Map.prototype.addSource, native);
});
