import test from 'node:test';
import assert from 'node:assert/strict';
import { queryNativeDirectedTrackGraph } from '../src/runtime/native-directed-track-search.js';

const edge = (coordsString, trackId, extra = {}) => ({ coordsString, trackId, trackLength: 100, ...extra });
const query = (graph, platforms = new Set()) => queryNativeDirectedTrackGraph(graph, platforms, 'start', 'end', { withPath: true });

test('native 1.7.2 crossover cost favors three straight segments over two lane changes', () => {
  const graph = new Map([
    ['start', [edge('cross', 'cross-1', { trackIsCrossover: true }), edge('straight-1', 'straight-1')]],
    ['cross', [edge('end', 'cross-2', { trackIsCrossover: true })]],
    ['straight-1', [edge('straight-2', 'straight-2')]],
    ['straight-2', [edge('end', 'straight-3')]],
  ]);
  const result = query(graph);
  assert.equal(result.distance, 3);
  assert.deepEqual(result.path.map(row => row.trackId), ['straight-1', 'straight-2', 'straight-3']);
  assert.equal(queryNativeDirectedTrackGraph(graph, new Set(), 'start', 'end').distance, result.distance);
});

test('crossover, wrong-way, and intermediate-platform penalties accumulate without changing physical length', () => {
  const graph = new Map([['start', [edge('end', 7, { trackIsCrossover: true, trackIsReversed: true, trackLength: 275 })]]]);
  const result = query(graph, new Set(['7']));
  assert.equal(result.distance, 38.1);
  assert.deepEqual(result.path, [{ trackId: '7', reversed: true, length: 275, signals: [] }]);
});

test('stable equal-cost choices preserve native edge order and prefer the first discovered path', () => {
  const graph = new Map([
    ['start', [edge('a', 'first'), edge('b', 'second')]],
    ['a', [edge('end', 'first-end')]], ['b', [edge('end', 'second-end')]],
  ]);
  assert.deepEqual(query(graph).path.map(row => row.trackId), ['first', 'first-end']);
});

test('relaxation skips superseded frontier entries and reaches the cheaper path', () => {
  const graph = new Map([
    ['start', [edge('a', 'expensive', { trackIsReversed: true }), edge('b', 'cheap')]],
    ['b', [edge('a', 'relax')]], ['a', [edge('end', 'finish')]],
  ]);
  assert.deepEqual(query(graph).path.map(row => row.trackId), ['cheap', 'relax', 'finish']);
  assert.equal(query(graph).distance, 3);
});

test('a missing directed return remains unreachable and malformed edges do not invent connectivity', () => {
  const graph = new Map([['start', [null, edge('', 'empty'), edge('one-way', 'outbound')]]]);
  assert.deepEqual(query(graph), { distance: Infinity, path: null });
  assert.deepEqual(queryNativeDirectedTrackGraph(graph, new Set(), 'start', 'start', { withPath: true }), { distance: 0, path: [] });
});

test('legacy reversed and length fields remain supported for existing delivered graph fixtures', () => {
  const graph = new Map([['start', [{ coordsString: 'end', trackId: 'legacy', reversed: true, length: 50 }]]]);
  assert.deepEqual(query(graph), { distance: 26, path: [{ trackId: 'legacy', reversed: true, length: 50, signals: [] }] });
});
