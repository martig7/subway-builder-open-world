import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modTestDirectory = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(modTestDirectory, '..', '..');
const serverScript = path.join(prototypeRoot, 'tools', 'native-pmtiles-server.ps1');
const tileRoot = path.join(prototypeRoot, 'generated', 'pilot', 'tiles');
const archivePath = path.join(tileRoot, 'NY_CP00_RP00', 'tiles.pmtiles');
const nativePowerShell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

test('native PMTiles extraction returns raw MVT bytes', {
  skip: process.platform !== 'win32' || !fs.existsSync(archivePath),
}, () => {
  const output = execFileSync(nativePowerShell, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', serverScript,
    '-Root', tileRoot,
    '-CheckOnly',
    '-CheckTile', 'NY_CP00_RP00/2/2/2',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));

  assert.equal(result.TileType, 1);
  assert.equal(result.TileCompression, 2);
  assert.ok(result.Length > 0);
  // MVT's top-level `layers` field is a length-delimited protobuf field.
  // A gzip payload would start with 0x1f, 0x8b instead.
  assert.equal(result.FirstBytes[0], 0x1a);
});

test('native PMTiles extraction wraps horizontal world coordinates', {
  skip: process.platform !== 'win32' || !fs.existsSync(archivePath),
}, () => {
  const output = execFileSync(nativePowerShell, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', serverScript,
    '-Root', tileRoot,
    '-CheckOnly',
    '-CheckTile', 'NY_CP00_RP00/0/1/0',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));

  assert.equal(result.X, 0);
  assert.ok(result.Length > 0);
  assert.equal(result.FirstBytes[0], 0x1a);
});
