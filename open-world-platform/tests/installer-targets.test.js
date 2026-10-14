import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveInstallTargets } from '../src/installer/install-world-mod.js';

const applicationDataPath = path.resolve('fixture', 'metro-maker4');

test('consumer dependency setup never registers a deployment lifecycle script', async () => {
  for (const world of ['ny-state', 'nec-corridor', 'tokyo-kanagawa', 'japan']) {
    const pkg = JSON.parse(await readFile(new URL(`../../prototype/${world}/mod/package.json`, import.meta.url)));
    assert.equal(pkg.scripts.install, undefined, world);
    assert.equal(pkg.scripts['install:mod'], 'node scripts/install-mod.mjs', world);
  }
});

test('installer resolves a manifest-scoped target under the application data root', () => {
  const definition = { identity: { manifestId: 'local.nec-corridor-open-world' } };
  const targets = resolveInstallTargets({ definition, applicationDataPath });
  assert.equal(targets.targetPath, path.join(applicationDataPath, 'mods', 'nec-corridor-open-world'));
});

test('installer honors an explicit deployment directory alias', () => {
  const definition = {
    identity: { manifestId: 'local.japan-open-world' },
    release: { installDirectoryName: 'local.japan-open-world' },
  };
  const targets = resolveInstallTargets({ definition, applicationDataPath });
  assert.equal(targets.targetPath, path.join(applicationDataPath, 'mods', 'local.japan-open-world'));
});

test('installer rejects an unsafe manifest suffix', () => {
  assert.throws(() => resolveInstallTargets({
    definition: { identity: { manifestId: 'local..' } },
    applicationDataPath,
  }), /Unsafe mod install directory/);
});

test('installer rejects an unsafe explicit deployment directory alias', () => {
  assert.throws(() => resolveInstallTargets({
    definition: {
      identity: { manifestId: 'local.japan-open-world' },
      release: { installDirectoryName: '../japan-open-world' },
    },
    applicationDataPath,
  }), /Unsafe mod install directory/);
});
