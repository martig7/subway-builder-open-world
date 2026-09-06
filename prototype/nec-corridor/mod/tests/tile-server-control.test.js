import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureTileServerReady,
  NATIVE_PMTILES_SERVER_VERSION,
  stopTileServer,
} from '../scripts/tile-server-control.mjs';

function healthyResponse() {
  return {
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'x-pmtiles-server-version'
      ? NATIVE_PMTILES_SERVER_VERSION
      : null },
    arrayBuffer: async () => Uint8Array.of(0x1a).buffer,
  };
}

test('keeps polling when the attached startup wrapper exits successfully', async () => {
  let probeCount = 0;
  let spawnOptions = null;
  const fetchImpl = async () => {
    probeCount += 1;
    return probeCount >= 3 ? healthyResponse() : { ok: false };
  };
  const child = new EventEmitter();
  child.exitCode = null;
  child.unref = () => {};
  const spawnImpl = (_command, _args, options) => {
    spawnOptions = options;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('spawn');
      child.emit('close', 0);
    });
    return child;
  };

  const result = await ensureTileServerReady({
    platform: 'win32',
    starterPath: 'installed/start-tile-server.ps1',
    fetchImpl,
    spawnImpl,
  });

  assert.deepEqual(result, { status: 'started', baseUrl: 'http://127.0.0.1:8799' });
  assert.equal(probeCount, 3);
  assert.deepEqual(spawnOptions, { stdio: 'ignore', windowsHide: true });
});

test('requests a verified foreground stop through the installed-server controller', async () => {
  let invocation = null;
  const child = new EventEmitter();
  child.exitCode = null;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  };

  const result = await stopTileServer({
    platform: 'win32',
    starterPath: 'workspace/start-tile-server.ps1',
    installRoot: 'C:\\installed\\nec-corridor-open-world',
    spawnImpl,
  });

  assert.deepEqual(result, { status: 'stopped' });
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'workspace/start-tile-server.ps1',
    '-Port',
    '8799',
    '-Stop',
    '-ExpectedInstallRoot',
    'C:\\installed\\nec-corridor-open-world',
  ]);
  assert.deepEqual(invocation.options, { stdio: 'ignore', windowsHide: true });
});

// Installer replacement ordering and unchanged-file reuse are exercised through
// temporary installs in open-world-platform/tests/artifact-install.test.js.
