import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_RECOVERY_ID,
  NETWORK_RECOVERY_NATIVE_ROUTE_IDS,
  NETWORK_RECOVERY_REPLACE_ROUTE_IDS,
  NETWORK_RECOVERY_ROUTE_IDS,
  NETWORK_RECOVERY_SIDECAR_ROUTE_IDS,
  NETWORK_RECOVERY_WORLD_IDS,
} from '../src/network-recovery-config.js';

test('corridor recovery includes regional, Albany, and native NYC routes', () => {
  assert.deepEqual(new Set(NETWORK_RECOVERY_ROUTE_IDS), new Set([
    '2a6cb02f-4a78-4ac0-b0d0-16fef8c755bb',
    'da40e3d7-1257-41af-b10d-eec737d47467',
    '22db486a-28d5-4b6d-899c-e986335c6f93',
    'a707a2be-d39a-400b-b73a-f2b61ee4e639',
    'b13a0ef3-deec-473b-88d1-d7bdc2d4acac',
    'd7b58cd2-b68c-4fc5-b860-b3747e0b97d5',
    '36901c8e-b76c-4d3e-921e-adb1860286f0',
    '9160dcdd-30d2-4a7e-821e-c560a45b48a5',
  ]));
  assert.equal(NETWORK_RECOVERY_SIDECAR_ROUTE_IDS.length, 5);
  assert.equal(NETWORK_RECOVERY_NATIVE_ROUTE_IDS.length, 3);
});

test('recovery revision reruns after the NYC autosave topology loss', () => {
  assert.match(NETWORK_RECOVERY_ID, /full-corridor-autosave-loss-v9$/);
  assert.deepEqual(NETWORK_RECOVERY_REPLACE_ROUTE_IDS, [
    '2a6cb02f-4a78-4ac0-b0d0-16fef8c755bb',
  ]);
  assert.equal(NETWORK_RECOVERY_WORLD_IDS.has('91ca6ae2-1661-4642-823b-3652204c1537'), true);
  assert.equal(NETWORK_RECOVERY_WORLD_IDS.has('969e5d4d-62d2-463f-99b2-235ca101f372'), true);
});
