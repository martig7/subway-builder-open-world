import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenWorldCityRegistration } from '../src/runtime/open-world-city-registration.js';

test('explicit tile navigation recenters an overview camera but ordinary repair preserves it', () => {
  const registration = createOpenWorldCityRegistration({ definition: { runtime: { tileServerPort: 8799 }, map: {}, identity: { name: 'Test' } },
    tileCatalog: { tiles: [{ id: 'B', bounds: [10, 10, 20, 20], initialViewState: { longitude: 15, latitude: 15, zoom: 11 } }] } });
  const moves = [];
  const map = { getZoom: () => 4, getCenter: () => ({ lng: 0, lat: 0 }), jumpTo: camera => moves.push(camera) };
  assert.equal(registration.repairPilotMapCamera(map, 'B').status, 'world-view');
  assert.equal(registration.repairPilotMapCamera(map, 'B', { force: true }).status, 'recentered');
  assert.deepEqual(moves[0].center, [15, 15]);
});
