import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeMapLayerMoves } from '../src/runtime/map-layer-stability.js';

test('late native image callback cannot access the removed map style', () => {
  class Map {
    constructor() { this.style = { getImage: () => false }; }
    hasImage(id) { return this.style.getImage(id); }
    addImage() { this.style.imageAdded = true; }
  }
  const map = new Map();
  stabilizeMapLayerMoves(map);
  delete map.style;
  map._removed = true;
  const onload = () => { if (!map.hasImage('icon')) map.addImage('icon', {}); };
  assert.doesNotThrow(onload);
});

test('image guard preserves live behavior, errors, and stable wrapper identity', () => {
  const map = { style: {}, hasImage: () => true, addImage() { throw new Error('invalid image'); } };
  stabilizeMapLayerMoves(map);
  const wrapped = map.hasImage;
  stabilizeMapLayerMoves(map);
  assert.equal(map.hasImage, wrapped);
  assert.equal(map.hasImage('existing'), true);
  assert.throws(() => map.addImage('invalid'), /invalid image/);
});
