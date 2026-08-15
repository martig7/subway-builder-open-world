import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeMapLayerMoves } from '../src/map-layer-stability.js';

function fixtureMap(layerIds) {
  const layers = new Set(layerIds);
  const calls = [];
  return {
    calls,
    getLayer: (id) => layers.has(id) ? { id } : undefined,
    moveLayer(id, beforeId) {
      calls.push([id, beforeId]);
      if (!layers.has(id)) throw new Error(`Cannot move layer "${id}" because it does not exist.`);
      if (beforeId != null && !layers.has(beforeId)) {
        throw new Error(`Cannot move layer "${id}" before non-existing layer "${beforeId}".`);
      }
      return this;
    },
  };
}

test('a transiently missing Deck anchor does not throw or reach raw MapLibre moveLayer', () => {
  const map = fixtureMap(['construction-tracks-base']);
  stabilizeMapLayerMoves(map);

  assert.doesNotThrow(() => map.moveLayer('construction-tracks-base', 'tracks-base'));
  assert.deepEqual(map.calls, []);
});

test('valid layer moves retain native MapLibre behavior', () => {
  const map = fixtureMap(['construction-tracks-base', 'tracks-base']);
  stabilizeMapLayerMoves(map);

  assert.equal(map.moveLayer('construction-tracks-base', 'tracks-base'), map);
  assert.deepEqual(map.calls, [['construction-tracks-base', 'tracks-base']]);
});

test('hot reload does not wrap moveLayer repeatedly', () => {
  const map = fixtureMap(['road-lines-major', 'road-lines-highway']);
  stabilizeMapLayerMoves(map);
  const guarded = map.moveLayer;
  stabilizeMapLayerMoves(map);

  assert.equal(map.moveLayer, guarded);
  map.moveLayer('road-lines-major', 'road-lines-highway');
  assert.deepEqual(map.calls, [['road-lines-major', 'road-lines-highway']]);
});
