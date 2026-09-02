import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeneratedRoadGraph,
  routeGeneratedRoadGraph,
} from '../../../../open-world-platform/src/runtime/generated-road-routing.js';

const feature = (roadClass, coordinates) => ({
  type: 'Feature', properties: { roadClass }, geometry: { type: 'LineString', coordinates },
});

test('generated road renderer minimizes effective driving time and returns road geometry', () => {
  const graph = buildGeneratedRoadGraph([{ type: 'FeatureCollection', features: [
    feature('minor', [[0, 0], [0.04, 0]]),
    feature('highway', [[0, 0], [0, 0.005], [0.04, 0.005], [0.04, 0]]),
  ] }]);
  const route = routeGeneratedRoadGraph(graph, [0, 0], [0.04, 0]);
  assert.ok(route);
  assert.ok(route.coordinates.some((coordinate) => coordinate[1] === 0.005), 'fast highway detour should be rendered');
  assert.deepEqual(route.coordinates[0], [0, 0]);
  assert.deepEqual(route.coordinates.at(-1), [0.04, 0]);
});

test('overlapping tile halos deduplicate identical road segments', () => {
  const roads = { type: 'FeatureCollection', features: [feature('major', [[0, 0], [0.01, 0]])] };
  const graph = buildGeneratedRoadGraph([roads, structuredClone(roads)]);
  assert.equal(graph.nodeCount, 2);
  assert.equal(graph.edgeCount, 2, 'one undirected segment is stored once');
});

test('disconnected and excessive-detour routes fall back through a null result', () => {
  const graph = buildGeneratedRoadGraph([{ type: 'FeatureCollection', features: [
    feature('minor', [[0, 0], [0.01, 0]]),
    feature('minor', [[1, 1], [1.01, 1]]),
  ] }]);
  assert.equal(routeGeneratedRoadGraph(graph, [0, 0], [1, 1]), null);
});
