import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tileServerHealthUrl } from '../scripts/tile-server-control.mjs';

test('Tokyo–Kanagawa readiness probes a tile that exists in the clipped archive', () => {
  assert.equal(
    tileServerHealthUrl(),
    'http://127.0.0.1:8799/JP_TOKYO_MAINLAND/8/227/100.mvt?v=tokyo-kanagawa-mainland-v2',
  );
});

test('Windows PowerShell starter remains ASCII-safe', async () => {
  const source = await readFile(new URL('../start-tile-server.ps1', import.meta.url), 'utf8');
  assert.equal(/[^\x00-\x7f]/u.test(source), false);
});
