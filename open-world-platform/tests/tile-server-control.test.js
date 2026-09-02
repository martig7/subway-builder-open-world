import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ensureTileServerReady,
  NATIVE_PMTILES_SERVER_VERSION,
  stopTileServer,
  tileServerHealthUrl,
} from '../src/installer/tile-server-control.js';

const definition = {
  runtime: {
    tileServerPort: 9123,
    healthTile: 'TILE_A/2/1/1.mvt?v=fixture-v1',
  },
};

function childThatCloses(code = 0) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}

function healthyResponse() {
  return {
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'x-pmtiles-server-version' ? NATIVE_PMTILES_SERVER_VERSION : null },
    arrayBuffer: async () => Uint8Array.of(0x1a).buffer,
  };
}

test('readiness rejects an unversioned server, starts the configured service, and verifies a tile', async () => {
  const probes = [];
  const invocations = [];
  let probe = 0;
  const result = await ensureTileServerReady({
    definition,
    platform: 'win32',
    starterPath: 'installed/start-tile-server.ps1',
    fetchImpl: async (url) => {
      probes.push(url);
      probe += 1;
      return probe === 1
        ? { ok: true, headers: { get: () => null }, arrayBuffer: async () => Uint8Array.of(0x1a).buffer }
        : healthyResponse();
    },
    spawnImpl: (command, args, options) => {
      invocations.push({ command, args, options });
      return childThatCloses();
    },
  });

  assert.deepEqual(result, { status: 'started', baseUrl: 'http://127.0.0.1:9123' });
  assert.deepEqual(probes, [tileServerHealthUrl(definition), tileServerHealthUrl(definition)]);
  assert.deepEqual(invocations[0].args.slice(-3), ['-Port', '9123', '-Background']);
  assert.deepEqual(invocations[0].options, { stdio: 'ignore', windowsHide: true });
});

test('shutdown carries the configured port and verified install root', async () => {
  let invocation;
  const result = await stopTileServer({
    definition,
    platform: 'win32',
    starterPath: 'workspace/start-tile-server.ps1',
    installRoot: 'C:\\installed\\fixture',
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return childThatCloses();
    },
  });

  assert.deepEqual(result, { status: 'stopped' });
  assert.deepEqual(invocation.args.slice(-5), ['-Port', '9123', '-Stop', '-ExpectedInstallRoot', 'C:\\installed\\fixture']);
});
