import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSharedTileServerHealth,
  monitorSharedTileServerHealth,
} from '../src/runtime/tile-server-health.js';

function createFakeDocument() {
  const elements = new Map();
  const body = {
    children: [],
    appendChild(element) {
      element.parentNode = body;
      body.children.push(element);
      if (element.id) elements.set(element.id, element);
      return element;
    },
    removeChild(element) {
      body.children = body.children.filter((candidate) => candidate !== element);
      if (element.id) elements.delete(element.id);
      element.parentNode = null;
    },
  };
  return {
    body,
    createElement(tagName) {
      return {
        tagName,
        id: '',
        role: '',
        style: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this[name] = value; },
      };
    },
    getElementById(id) { return elements.get(id) ?? null; },
  };
}

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

test('loading-screen warning remains visible until the shared tile server starts', async () => {
  const documentObject = createFakeDocument();
  const globalObject = {};
  const scheduled = [];
  let serverRunning = false;

  const first = await monitorSharedTileServerHealth({
    tileBase: 'http://127.0.0.1:8799',
    fetchImpl: async () => {
      if (!serverRunning) throw new TypeError('fetch failed');
      return { ok: true, headers: new Map([['X-PMTiles-Server-Version', 'native-pmtiles-directory-v4']]) };
    },
    notify: () => { throw new Error('notification surface unavailable during loading'); },
    globalObject,
    documentObject,
    scheduleRetry(callback, delay) {
      assert.equal(delay, 2_000);
      scheduled.push(callback);
      return scheduled.length;
    },
  });

  assert.equal(first.status, 'unavailable');
  assert.equal(documentObject.body.children.length, 1);
  assert.equal(documentObject.body.children[0].role, 'alert');
  assert.match(documentObject.body.children[0].textContent, /tile server is not running/i);
  assert.equal(documentObject.body.children[0].style.zIndex, '2147483647');

  serverRunning = true;
  const second = await scheduled.shift()();

  assert.equal(second.status, 'running');
  assert.equal(documentObject.body.children.length, 0);
});
