import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPEN_WORLD_MAX_ZOOM,
  OPEN_WORLD_MIN_ZOOM,
  relaxMapZoomLimits,
} from '../src/map-zoom-limits.js';

test('relaxes the native city camera clamp to the MapLibre camera range', () => {
  let minZoom = 9;
  let maxZoom = 24;
  const map = {
    getMinZoom: () => minZoom,
    getMaxZoom: () => maxZoom,
    setMinZoom: (value) => { minZoom = value; },
    setMaxZoom: (value) => { maxZoom = value; },
  };

  assert.deepEqual(relaxMapZoomLimits(map), {
    status: 'relaxed',
    previousMinZoom: 9,
    previousMaxZoom: 24,
    requestedMinZoom: OPEN_WORLD_MIN_ZOOM,
    sourceMinZoom: null,
    minZoom: OPEN_WORLD_MIN_ZOOM,
    maxZoom: OPEN_WORLD_MAX_ZOOM,
  });
  assert.equal(minZoom, 0);
  assert.equal(maxZoom, 24);
});

test('does not fail when a map implementation does not expose camera setters', () => {
  assert.deepEqual(relaxMapZoomLimits(null), { status: 'unsupported' });
  assert.deepEqual(relaxMapZoomLimits({}), { status: 'unsupported' });
});

test('camera cannot zoom below the lowest basemap tile level', () => {
  let minZoom = 9;
  const map = {
    getMinZoom: () => minZoom,
    getMaxZoom: () => 24,
    setMinZoom: (value) => { minZoom = value; },
    setMaxZoom: () => {},
  };

  const result = relaxMapZoomLimits(map, {
    minZoom: 0,
    sourceMinZoom: 5,
  });

  assert.equal(result.minZoom, 5);
  assert.equal(minZoom, 5);
});
