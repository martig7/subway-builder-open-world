import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalPathSelection,
  CANONICAL_PATH_SELECTION_INDEX_KEY,
  CANONICAL_PATH_SELECTION_PREFIX,
} from '../src/canonical-path-selection.js';

const paths = [
  { id: 'main', label: 'Main world', worldId: 'world-main' },
  { id: 'recovered', label: 'Recovered world', worldId: 'world-recovered' },
  { id: 'isolated', label: 'Keep separate', nativeSession: true },
];

test('selection has no implicit path and can be resolved explicitly', async () => {
  const storage = new Map();
  const selector = new CanonicalPathSelection({ storage, paths });
  await selector.initialize();

  assert.equal(await selector.selectionFor({ nativeSessionId: 'native-1', saveName: 'New York' }), null);
  const selected = await selector.choose({
    nativeSessionId: 'native-1',
    saveName: 'New York',
    pathId: 'main',
  });

  assert.equal(selected.worldId, 'world-main');
  assert.equal((await selector.selectionFor({ nativeSessionId: 'native-1', saveName: 'New York' })).pathId, 'main');
  assert.equal((await selector.selectionFor({ nativeSessionId: 'native-1', saveName: 'Another save' })).pathId, 'main');
  assert.deepEqual(storage.get(CANONICAL_PATH_SELECTION_INDEX_KEY).paths.map(({ id }) => id), ['main', 'recovered', 'isolated']);
  assert.ok([...storage.keys()].some((key) => key.startsWith(CANONICAL_PATH_SELECTION_PREFIX)));
});

test('native-save-only resolves to the current session and waits for a user choice', async () => {
  const selector = new CanonicalPathSelection({ storage: new Map(), paths });
  const waiting = selector.waitForSelection({ nativeSessionId: 'native-2', saveName: 'Save 2' });
  const selected = await selector.choose({ nativeSessionId: 'native-2', pathId: 'isolated' });

  assert.equal((await waiting).worldId, 'native-2');
  assert.equal(selected.worldId, 'native-2');
  assert.equal(selector.snapshot({ nativeSessionId: 'native-2' }).selection.pathId, 'isolated');
});

