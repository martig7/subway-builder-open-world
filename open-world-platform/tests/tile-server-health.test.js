import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSharedTileServerHealth } from '../src/runtime/tile-server-health.js';

test('healthy shared tile server does not notify the player', async () => {
  const notifications = [];
  const globalObject = {};

  const result = await checkSharedTileServerHealth({
    tileBase: 'http://127.0.0.1:8799',
    fetchImpl: async () => ({ ok: true, headers: new Map([['X-PMTiles-Server-Version', 'native-pmtiles-directory-v4']]) }),
    notify: (...args) => notifications.push(args),
    globalObject,
  });

  assert.equal(result.status, 'running');
  assert.deepEqual(notifications, []);
});

test('unavailable shared tile server gives one actionable notification across world mods', async () => {
  const notifications = [];
  const globalObject = {};
  const options = {
    tileBase: 'http://127.0.0.1:8799',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    notify: (...args) => notifications.push(args),
    globalObject,
  };

  const first = await checkSharedTileServerHealth(options);
  const second = await checkSharedTileServerHealth(options);

  assert.equal(first.status, 'unavailable');
  assert.equal(second.status, 'already-reported');
  assert.deepEqual(notifications, [[
    "Open World tile server isn't running. Open Subway Builder Open World from the Start menu.",
    'error',
    'Open World',
  ]]);
});

test('unexpected process on the shared port is treated as unavailable', async () => {
  const notifications = [];

  const result = await checkSharedTileServerHealth({
    tileBase: 'http://127.0.0.1:8799/',
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:8799/_health');
      return { ok: true, headers: new Map([['X-PMTiles-Server-Version', 'other-server']]) };
    },
    notify: (...args) => notifications.push(args),
    globalObject: {},
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(notifications.length, 1);
});
