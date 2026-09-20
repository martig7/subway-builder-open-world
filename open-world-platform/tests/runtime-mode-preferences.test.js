import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeModePreferences } from '../src/runtime/runtime-mode-preferences.js';

const storage = () => {
  const rows = new Map();
  return { rows, getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) };
};

test('both explicit on and off choices survive a fresh preference instance', () => {
  const disk = storage();
  const open = () => createRuntimeModePreferences({ modId: 'japan', storage: disk });
  const first = open();
  assert.equal(first.snapshot().ultraHighSpeed, false);
  first.setUltraHighSpeed(true); first.setExperimentalAutosaves(true);
  const next = open();
  assert.equal(next.snapshot().ultraHighSpeed, true);
  assert.equal(next.snapshot().experimentalAutosaves, true);
  next.setUltraHighSpeed(false); next.setExperimentalAutosaves(false);
  assert.equal(open().snapshot().ultraHighSpeed, false);
  assert.equal(open().snapshot().experimentalAutosaves, false);
  assert.deepEqual(JSON.parse([...disk.rows.values()][0]), {
    schemaVersion: 1, ultraHighSpeed: false, experimentalAutosaves: false,
  });
});

test('preferences belong to the runnable mod, across saves and Tile Views', () => {
  const disk = storage();
  createRuntimeModePreferences({ modId: 'japan', storage: disk }).setUltraHighSpeed(true);
  assert.equal(createRuntimeModePreferences({ modId: 'nec', storage: disk }).snapshot().ultraHighSpeed, false);
});

test('hot upgrade adopts current choices only when no persisted preference exists', () => {
  const disk = storage();
  const first = createRuntimeModePreferences({ modId: 'japan', storage: disk,
    initialChoices: { ultraHighSpeed: true, experimentalAutosaves: true } });
  assert.equal(first.snapshot().persisted, true);
  const next = createRuntimeModePreferences({ modId: 'japan', storage: disk,
    initialChoices: { ultraHighSpeed: false, experimentalAutosaves: false } });
  assert.equal(next.snapshot().ultraHighSpeed, true);
  assert.equal(next.snapshot().experimentalAutosaves, true);
});

test('malformed, future and non-boolean stored values cannot enable either mode', () => {
  for (const raw of ['{', '{"schemaVersion":2,"ultraHighSpeed":true}',
    '{"schemaVersion":1,"ultraHighSpeed":"true","experimentalAutosaves":1}', 'x'.repeat(5000)]) {
    const prefs = createRuntimeModePreferences({ modId: 'japan', storage: { getItem: () => raw } });
    assert.equal(prefs.snapshot().ultraHighSpeed, false);
    assert.equal(prefs.snapshot().experimentalAutosaves, false);
  }
});

test('storage failures leave the current choice usable and report that it was not persisted', () => {
  const prefs = createRuntimeModePreferences({ modId: 'japan', storage: {
    getItem() { throw Error('denied'); }, setItem() { throw Error('full'); },
  } });
  prefs.setUltraHighSpeed(true);
  assert.equal(prefs.snapshot().ultraHighSpeed, true);
  assert.equal(prefs.snapshot().persisted, false);
  assert.equal(prefs.snapshot().error, 'full');
});
