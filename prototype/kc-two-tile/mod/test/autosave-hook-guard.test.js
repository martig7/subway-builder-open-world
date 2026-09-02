import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeSaveLifecycle,
  OPEN_WORLD_RUNTIME_METADATA_KEY,
  OPEN_WORLD_RUNTIME_SAVE_NAME,
  openWorldRuntimeSnapshotProvenance,
  stampOpenWorldRuntimeSnapshot,
} from '../../../../open-world-platform/src/runtime/autosave-hook-guard.js';

test('blocks re-entrant save callbacks caused by captureSnapshot generateSave', () => {
  const guard = createNativeSaveLifecycle();

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

test('suppresses one delayed autosave load echo across mod generations without a timeout', () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const firstGeneration = createNativeSaveLifecycle({ sessionStorage, storageKey: 'test:save-echo' });

  assert.equal(firstGeneration.begin('Autosave', 'native-session-a'), true);
  firstGeneration.end();

  // Autosave can cause the mod script to be evaluated again before the
  // late-fire onGameLoaded callback. The correlation must survive that new
  // closure, however long the callback takes to arrive.
  const laterGeneration = createNativeSaveLifecycle({ sessionStorage, storageKey: 'test:save-echo' });
  assert.equal(
    laterGeneration.classifyLoad('Autosave', {
      nativeSessionId: 'native-session-a',
      pendingNavigation: false,
    }),
    'save-echo',
  );
  assert.equal(
    laterGeneration.classifyLoad('Autosave', {
      nativeSessionId: 'native-session-a',
      pendingNavigation: false,
    }),
    'save-load',
    'after the correlated echo is consumed, a user save load remains authoritative',
  );
});

test('classifies pending user tile navigation separately from native save loads', () => {
  const guard = createNativeSaveLifecycle();

  assert.equal(
    guard.classifyLoad('Autosave', {
      nativeSessionId: 'native-session-b',
      pendingNavigation: true,
    }),
    'tile-navigation',
  );
  assert.equal(
    guard.classifyLoad('Manual save', {
      nativeSessionId: 'native-session-c',
      pendingNavigation: false,
    }),
    'save-load',
  );
});

test('does not suppress a same-name save loaded from a different native session', () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const guard = createNativeSaveLifecycle({ sessionStorage, storageKey: 'test:save-echo' });

  guard.begin('Autosave', 'native-session-before-load');
  guard.end();

  assert.equal(
    guard.classifyLoad('Autosave', {
      nativeSessionId: 'native-session-from-save',
      pendingNavigation: false,
    }),
    'save-load',
  );
});

test('emits structured diagnostics for token persistence and load classification', () => {
  const values = new Map();
  const events = [];
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const guard = createNativeSaveLifecycle({
    sessionStorage,
    storageKey: 'test:trace-save-echo',
    trace: (event, details) => events.push({ event, details }),
  });

  guard.begin('Autosave', 'native-session-trace');
  guard.end();
  assert.equal(guard.classifyLoad('Autosave', {
    nativeSessionId: 'native-session-trace',
    pendingNavigation: false,
  }), 'save-echo');

  const tokenWrite = events.find(({ event }) => event === 'token.write');
  assert.equal(tokenWrite?.details.persisted, true);
  assert.deepEqual(tokenWrite?.details.token, {
    saveName: 'Autosave',
    nativeSessionId: 'native-session-trace',
  });
  assert.equal(
    events.findLast(({ event }) => event === 'classify.result')?.details.result,
    'save-echo',
  );
});

test('classifies explicitly tracked runtime snapshot callbacks independently of display name', async () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const lifecycle = createNativeSaveLifecycle({ sessionStorage, storageKey: 'test:runtime-save-echo' });

  lifecycle.begin('Autosave', 'native-session-runtime');
  await lifecycle.runInternalOperation({
    kind: 'runtime-snapshot-generate',
    saveName: OPEN_WORLD_RUNTIME_SAVE_NAME,
    nativeSessionId: 'native-session-runtime',
    metadataMarked: true,
  }, async () => {
    assert.equal(
      lifecycle.classifyLoad('unexpected-native-callback-name', {
        nativeSessionId: 'native-session-runtime',
        pendingNavigation: false,
      }),
      'internal-runtime',
      'active operation provenance, not display-name equality, classifies the callback',
    );
  });
  lifecycle.end();

  assert.equal(
    lifecycle.classifyLoad('kc-two-tile-runtime', {
      nativeSessionId: 'native-session-runtime',
      pendingNavigation: false,
    }),
    'internal-runtime',
    'legacy snapshots remain compatible during migration',
  );
  assert.equal(
    lifecycle.classifyLoad('Manual save', {
      nativeSessionId: 'native-session-runtime',
      pendingNavigation: false,
    }),
    'save-load',
    'a later user-selected save remains authoritative',
  );
});

test('classifies internal save callbacks without treating native saves as synthetic', async () => {
  const lifecycle = createNativeSaveLifecycle();

  await lifecycle.runInternalOperation({
    kind: 'runtime-snapshot-generate',
    saveName: OPEN_WORLD_RUNTIME_SAVE_NAME,
    nativeSessionId: 'native-session-runtime',
    metadataMarked: true,
  }, async () => {
    assert.equal(lifecycle.classifySave('unexpected-native-callback-name', {
      nativeSessionId: 'native-session-runtime',
    }), 'internal-runtime');
  });

  assert.equal(lifecycle.classifySave(OPEN_WORLD_RUNTIME_SAVE_NAME, {
    nativeSessionId: 'native-session-runtime',
  }), 'internal-runtime');
  assert.equal(lifecycle.classifySave('Autosave', {
    nativeSessionId: 'native-session-runtime',
  }), 'native-save');
});

test('stamps runtime snapshots with a generic name and durable provenance metadata', () => {
  const stamped = stampOpenWorldRuntimeSnapshot({
    name: 'legacy-display-name',
    metadata: { money: 42 },
  });

  assert.equal(stamped.name, OPEN_WORLD_RUNTIME_SAVE_NAME);
  assert.deepEqual(stamped.metadata[OPEN_WORLD_RUNTIME_METADATA_KEY], {
    schemaVersion: 1,
    purpose: 'tile-runtime',
  });
  assert.equal(stamped.metadata.money, 42);
  assert.deepEqual(openWorldRuntimeSnapshotProvenance(stamped), {
    internal: true,
    marker: { schemaVersion: 1, purpose: 'tile-runtime' },
    saveName: OPEN_WORLD_RUNTIME_SAVE_NAME,
    legacyName: false,
  });
  assert.equal(openWorldRuntimeSnapshotProvenance({ name: 'kc-two-tile-runtime' }).legacyName, true);
});
