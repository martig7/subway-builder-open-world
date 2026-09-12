import test from 'node:test';
import assert from 'node:assert/strict';
import { installMovementDeckVisibilityGuard } from '../src/runtime/ui/geographic-context-overlay.js';

class Layer {
  constructor(data, visible = true) { this.id = 'road-lines-major'; this.props = { data, visible }; }
  clone(overrides) { const layer = new Layer(this.props.data); layer.props = { ...this.props, ...overrides }; return layer; }
}

function fixture(features) {
  const data = { type: 'FeatureCollection', features };
  let clips = 0;
  const deck = { props: { layers: [new Layer(data)] }, setProps(next) { this.props = { ...this.props, ...next }; } };
  const map = { __deck: deck, getZoom: () => 14, getStyle: () => ({ layers: [] }), getBounds: () => [-2, -2, 2, 2] };
  const virtualization = { signature: 'memory-fixture', haloBounds: [[-2, -2, 2, 2]], renderInputs: ({ features: current }) => {
    clips++;
    return { features: current.filter(feature => feature.geometry.coordinates[0][0] < 2) };
  } };
  installMovementDeckVisibilityGuard(map, { map }, () => virtualization, () => 1);
  return { data, deck, clips: () => clips, update: visible => deck.setProps({ layers: [new Layer(data, visible)] }),
    cache: () => deck.__openWorldMovementDeckVisibilityGuard.spatialCache.get(features) };
}

const feature = id => ({ type: 'Feature', id, properties: { color: 'red' },
  geometry: { type: 'LineString', coordinates: Array.from({ length: 8 }, (_, n) => [n / 10, n / 10]) } });

test('large static road sources do not retain a second object graph for hidden validation', () => {
  const features = Array.from({ length: 10_000 }, (_, id) => feature(id));
  const f = fixture(features);
  assert.ok(f.cache().sourceSnapshot === null, 'large static geometry must not retain a detached validation graph');
  const rendered = f.deck.props.layers[0].props.data;
  f.update(true);
  assert.equal(f.clips(), 1, 'ordinary visible frames keep reusing their clipped data');
  assert.strictEqual(f.deck.props.layers[0].props.data, rendered);
  f.update(false);
  assert.equal(f.cache(), undefined, 'hiding drops optional large-geometry cache references');
  assert.strictEqual(f.deck.props.layers[0].props.data, rendered, 'hiding keeps inert uploaded data without rebuilding attributes');
  features[0].geometry.coordinates[0][0] = 10;
  f.update(true);
  assert.equal(f.clips(), 2, 'reveal clips once rather than retaining a large detached validation copy');
  assert.equal(f.deck.props.layers[0].props.data.features.length, features.length - 1);
  assert.equal(features.length, 10_000, 'canonical source data stays intact');
});

test('small static geometry retains hide/reveal reuse and catches hidden property edits', () => {
  const f = fixture([feature(0)]);
  assert.ok(f.cache().sourceSnapshot);
  const rendered = f.deck.props.layers[0].props.data;
  f.update(false); f.update(true);
  assert.strictEqual(f.deck.props.layers[0].props.data, rendered);
  assert.equal(f.clips(), 1);
  f.update(false);
  f.data.features[0].properties.color = 'blue';
  f.update(true);
  assert.equal(f.clips(), 2);
  assert.equal(f.deck.props.layers[0].props.data.features[0].properties.color, 'blue');
});
