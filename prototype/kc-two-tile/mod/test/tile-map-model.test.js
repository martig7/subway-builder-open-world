import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsPolygon, catalogBounds, fitBoundsView, lonLatToWorld, panView, projectCoordinate, unprojectPoint,
  visibleSlippyGrid, worldToLonLat, zoomViewAt,
} from '../src/tile-map-model.js';

const viewport = { width: 344, height: 230 };
const limits = { minZoom: 8, maxZoom: 15 };
const view = { center: [-94.607, 39], zoom: 10.6 };

test('Web Mercator projection round-trips Kansas City coordinates', () => {
  const coordinate = [-94.607, 39.1];
  const restored = worldToLonLat(lonLatToWorld(coordinate, 12), 12);
  assert.ok(Math.abs(restored[0] - coordinate[0]) < 1e-9);
  assert.ok(Math.abs(restored[1] - coordinate[1]) < 1e-9);
  const screen = projectCoordinate(coordinate, view, viewport);
  const fromScreen = unprojectPoint(screen, view, viewport);
  assert.ok(Math.abs(fromScreen[0] - coordinate[0]) < 1e-9);
  assert.ok(Math.abs(fromScreen[1] - coordinate[1]) < 1e-9);
});

test('pointer-anchored zoom preserves the geographic point beneath the cursor', () => {
  const anchor = [80, 60];
  const before = unprojectPoint(anchor, view, viewport);
  const zoomed = zoomViewAt(view, 2, anchor, viewport, limits);
  const after = unprojectPoint(anchor, zoomed, viewport);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-9);
  assert.ok(Math.abs(after[1] - before[1]) < 1e-9);
  assert.equal(zoomed.zoom, 12.6);
});

test('slippy grid resolution changes with zoom while logical bounds stay geographic', () => {
  const lowGrid = visibleSlippyGrid({ ...view, zoom: 10.2 }, viewport);
  const highGrid = visibleSlippyGrid({ ...view, zoom: 12.2 }, viewport);
  assert.equal(lowGrid.zoom, 10);
  assert.equal(highGrid.zoom, 12);
  assert.ok(highGrid.cellKilometres < lowGrid.cellKilometres / 3.9);
  assert.equal(boundsPolygon([-94.9, 38.9, -94.6, 39.1], view, viewport).length, 4);
});

test('dragging pans the map without changing its zoom', () => {
  const moved = panView(view, [40, -20]);
  assert.equal(moved.zoom, view.zoom);
  assert.notDeepEqual(moved.center, view.center);
});

test('automatically fits an expanded tile catalog inside the atlas viewport', () => {
  const tiles = [
    { bounds: [-95.2, 38.8, -94.8, 39.2] },
    { bounds: [-94.8, 38.8, -94.4, 39.2] },
    { bounds: [-94.4, 38.8, -94.0, 39.2] },
  ];
  const bounds = catalogBounds(tiles);
  const fitted = fitBoundsView(bounds, viewport, 28, limits);
  const polygon = boundsPolygon(bounds, fitted, viewport);
  assert.ok(Math.min(...polygon.map(([x]) => x)) >= 27.9);
  assert.ok(Math.max(...polygon.map(([x]) => x)) <= viewport.width - 27.9);
  assert.ok(Math.min(...polygon.map(([, y]) => y)) >= 27.9);
  assert.ok(Math.max(...polygon.map(([, y]) => y)) <= viewport.height - 27.9);
});
