import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRouteTimings, repairRouteTimingIntegrity } from '../../../../open-world-platform/src/runtime/route-timing-integrity.js';

test('repairs the captured Empire Line nine-node route from its seven timing anchors', () => {
  const nodes = ['liberty', '42-out', '119-out', 'main-out', 'state', 'main-in', '119-in', '42-in', 'liberty'];
  const combo = (startStNodeId, endStNodeId, distance) => ({
    startStNodeId, endStNodeId, distance, path: [{ trackId: `${startStNodeId}-${endStNodeId}`, length: distance }],
  });
  const route = {
    id: 'empire-line',
    stNodes: nodes.map((id) => ({ id })),
    stCombos: [
      combo('liberty', '42-out', 5_981),
      combo('42-out', '119-out', 6_759),
      combo('42-out', 'main-out', 108_511),
      combo('main-out', 'state', 108_055),
      combo('state', 'main-in', 108_057),
      combo('main-in', '42-in', 108_509),
      combo('119-in', '42-in', 6_758),
      combo('42-in', 'liberty', 5_982),
    ],
    stComboTimings: [
      ['liberty', 0, 0, 40],
      ['42-out', 1, 259, 299],
      ['main-out', 2, 3_385.5, 3_425.5],
      ['state', 3, 6_498.5, 6_538.5],
      ['main-in', 4, 9_655, 9_695],
      ['42-in', 5, 12_781.5, 12_821.5],
      ['liberty', 6, 13_081, 13_121],
    ].map(([stNodeId, stNodeIndex, arrivalTime, departureTime]) => ({
      stNodeId, stNodeIndex, arrivalTime, departureTime,
    })),
  };

  const result = repairRouteTimingIntegrity(route);

  assert.equal(result.changed, true);
  assert.equal(result.route.stComboTimings.length, 9);
  assert.equal(result.route.stCombos.length, 8);
  assert.deepEqual(
    result.route.stCombos.map(({ startStNodeId, endStNodeId }) => `${startStNodeId}->${endStNodeId}`),
    nodes.slice(0, -1).map((id, index) => `${id}->${nodes[index + 1]}`),
  );
  assert.deepEqual(
    result.route.stComboTimings.map(({ stNodeId, stNodeIndex }) => [stNodeId, stNodeIndex]),
    nodes.map((id, index) => [id, index]),
  );
  const outbound119 = result.route.stComboTimings[2];
  assert.ok(outbound119.arrivalTime - route.stComboTimings[1].departureTime < 5 * 60);
  assert.ok(outbound119.arrivalTime - route.stComboTimings[1].departureTime > 2 * 60);
  assert.equal(result.route.stComboTimings[3].arrivalTime, 3_385.5, 'downstream timing anchor must not drift');
});

test('projects canonical timing indices onto the currently displayed route facade', () => {
  const canonical = {
    stNodes: ['remote-a', 'local-a', 'local-b', 'remote-b'].map((id) => ({ id })),
    stComboTimings: [
      { stNodeId: 'remote-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
      { stNodeId: 'local-a', stNodeIndex: 1, arrivalTime: 100, departureTime: 140 },
      { stNodeId: 'local-b', stNodeIndex: 2, arrivalTime: 220, departureTime: 260 },
      { stNodeId: 'remote-b', stNodeIndex: 3, arrivalTime: 320, departureTime: 360 },
    ],
  };

  const projected = projectRouteTimings(canonical, [{ id: 'local-a' }, { id: 'local-b' }]);

  assert.deepEqual(projected, [
    { stNodeId: 'local-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
    { stNodeId: 'local-b', stNodeIndex: 1, arrivalTime: 120, departureTime: 160 },
  ]);
});
