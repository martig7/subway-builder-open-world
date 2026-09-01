import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const modRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prototypeRoot = path.resolve(modRoot, '..');
const planScript = path.join(prototypeRoot, 'tools', 'build-unified-basemaps.ps1');
const buildScript = path.join(prototypeRoot, 'build-nec.ps1');

test('NEC PMTiles build preserves world geography at wide zooms', () => {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', planScript, '-PlanOnly'],
    { cwd: prototypeRoot, encoding: 'utf8' },
  );
  const plan = JSON.parse(stdout);

  assert.equal(plan.tileCount, 34);
  assert.deepEqual(plan.worldZooms, [0, 9]);
  assert.deepEqual(plan.cityZooms, [10, 15]);
  assert.deepEqual(plan.worldLayers, ['world_land', 'water', 'world_boundaries']);
  assert.equal(plan.containerPathProbe, '/work/generated/maps/tiles');
  assert.deepEqual(plan.worldProbes, [
    { zoom: 2, x: 2, y: 2 },
    { zoom: 8, x: 128, y: 128 },
  ]);
  assert.match(
    readFileSync(buildScript, 'utf8'),
    /tools\\build-unified-basemaps\.ps1/,
    'the normal NEC build must run the unified basemap stage',
  );
});
