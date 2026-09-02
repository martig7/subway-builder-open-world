import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInstallTargets } from '../src/installer/install-world-mod.js';

test('installer resolves a manifest-scoped target under the application data root', () => {
  const definition = { identity: { manifestId: 'local.nec-corridor-open-world' } };
  const targets = resolveInstallTargets({ definition, applicationDataPath: 'C:\\fixture\\metro-maker4' });
  assert.equal(targets.targetPath, 'C:\\fixture\\metro-maker4\\mods\\nec-corridor-open-world');
});

test('installer rejects an unsafe manifest suffix', () => {
  assert.throws(() => resolveInstallTargets({
    definition: { identity: { manifestId: 'local..' } },
    applicationDataPath: 'C:\\fixture\\metro-maker4',
  }), /Unsafe mod id/);
});
