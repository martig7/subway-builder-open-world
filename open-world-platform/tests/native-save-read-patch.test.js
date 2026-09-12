import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readAsarEntry, replaceAsarEntry, sha256 } from '../src/host/asar-entry.js';
import { applyNativeSaveReadPatch, restoreNativeSaveReadPatch, createNativeSaveReadPreload } from '../src/installer/native-save-read-patch.js';

function fixtureArchive() {
  const preload = Buffer.from('native preload'), other = Buffer.from('other native bytes\0\xff');
  const header = { files: { dist: { files: { preload: { files: { 'preload.js': {
    offset: '0', size: preload.length, integrity: { algorithm: 'SHA256', hash: sha256(preload), blockSize: 8,
      blocks: [sha256(preload.subarray(0, 8)), sha256(preload.subarray(8))] },
  } } } } }, 'other.bin': { offset: String(preload.length), size: other.length } } };
  const json = Buffer.from(JSON.stringify(header)), size = 4 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(12 + size);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(size + 4, 4); prefix.writeUInt32LE(size, 8);
  prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, preload, other]);
}

test('prepended optimization retains the original preload strict mode', () => {
  const source = Buffer.from('"use strict"; accidentalGlobal = true;');
  const patched = createNativeSaveReadPreload(source);
  assert.ok(patched.subarray(-source.length).equals(source));
  assert.throws(() => vm.runInNewContext(patched.toString(), {
    require: () => ({ contextBridge: {} }),
  }), /accidentalGlobal is not defined/);
});

test('ASAR replacement preserves every unrelated entry and updates preload integrity', () => {
  const before = fixtureArchive(), snapshot = Buffer.from(before), content = Buffer.from('replacement preload that spans integrity blocks');
  const after = replaceAsarEntry(before, 'dist/preload/preload.js', content);
  assert.deepEqual(readAsarEntry(after, 'dist/preload/preload.js'), content);
  assert.deepEqual(readAsarEntry(after, 'other.bin'), readAsarEntry(before, 'other.bin'));
  assert.deepEqual(before, snapshot);
  const header = JSON.parse(after.subarray(16, 16 + after.readUInt32LE(12)));
  const entry = header.files.dist.files.preload.files['preload.js'];
  assert.equal(entry.integrity.hash, sha256(content));
  assert.equal(entry.integrity.blocks.length, Math.ceil(content.length / 8));
  assert.throws(() => readAsarEntry(after, '../preload.js'), /Invalid/);
  assert.throws(() => readAsarEntry(after.subarray(0, 10), 'other.bin'), /Invalid/);
});

test('native installation backs up exact bytes, rejects changed games, and restores exactly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-native-read-'));
  try {
    await mkdir(path.join(root, 'resources'));
    const archivePath = path.join(root, 'resources', 'app.asar'), stagedPath = path.join(root, 'staged.asar');
    const original = fixtureArchive();
    const patched = replaceAsarEntry(original, 'dist/preload/preload.js', Buffer.from('/* OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1 */ optimized'));
    await writeFile(archivePath, original); await writeFile(stagedPath, patched);
    const plan = { schemaVersion: 1, marker: 'OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1', archivePath, stagedPath,
      originalSha256: sha256(original), patchedSha256: sha256(patched),
      preloadSha256: sha256(readAsarEntry(patched, 'dist/preload/preload.js')) };
    await assert.rejects(applyNativeSaveReadPatch({ ...plan, originalSha256: 'changed' }), /changed/);
    assert.deepEqual(await readFile(archivePath), original);
    const result = await applyNativeSaveReadPatch(plan);
    assert.deepEqual(await readFile(result.backupPath), original);
    assert.deepEqual(await readFile(archivePath), patched);
    await writeFile(archivePath, Buffer.from('new game update'));
    await assert.rejects(restoreNativeSaveReadPatch({ gameRoot: root }), /changed/);
    assert.equal((await readFile(archivePath)).toString(), 'new game update');
    await writeFile(archivePath, patched);
    await restoreNativeSaveReadPatch({ gameRoot: root });
    assert.deepEqual(await readFile(archivePath), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
