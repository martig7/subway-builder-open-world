import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaveHookGuard } from '../src/autosave-hook-guard.js';

test('blocks re-entrant save callbacks caused by captureSnapshot generateSave', () => {
  const guard = createAutosaveHookGuard();

  assert.equal(guard.begin('Autosave'), true);
  assert.equal(guard.isActive(), true);
  assert.equal(guard.isNestedSave('Autosave'), true);
  assert.equal(guard.begin('Autosave'), false);
  assert.equal(guard.begin('Manual save'), false);
  assert.equal(guard.isNestedLoad('Autosave'), true);
  assert.equal(guard.isNestedLoad('Different save'), false);

  guard.end();
  assert.equal(guard.isActive(), false);
  assert.equal(guard.isNestedSave('Autosave'), false);
  assert.equal(guard.begin('Manual save'), true);
});
