import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readAsarEntry, replaceAsarEntry, sha256 } from '../src/host/asar-entry.js';
import { createNativeSaveReadPatchInstaller, createNativeSaveReadPreload,
  prepareNativeSaveReadPatch as prepareProductionPatch } from '../src/installer/native-save-read-patch.js';

const { prepareNativeSaveReadPatch, applyNativeSaveReadPatch, restoreNativeSaveReadPatch } = createNativeSaveReadPatchInstaller({
  supportedBuilds: [{ version: '1.7.0', preloadSha256: sha256(Buffer.from('native preload')) }],
});

function fixtureArchive() {
  const preload = Buffer.from('native preload'), other = Buffer.from('other native bytes\0\xff');
  const packageInfo = Buffer.from('{"version":"1.7.0"}');
  const header = { files: { dist: { files: { preload: { files: { 'preload.js': {
    offset: '0', size: preload.length, integrity: { algorithm: 'SHA256', hash: sha256(preload), blockSize: 8,
      blocks: [sha256(preload.subarray(0, 8)), sha256(preload.subarray(8))] },
  } } } } }, 'other.bin': { offset: String(preload.length), size: other.length },
    'package.json': { offset: String(preload.length + other.length), size: packageInfo.length } } };
  const json = Buffer.from(JSON.stringify(header)), size = 4 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(12 + size);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(size + 4, 4); prefix.writeUInt32LE(size, 8);
  prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, preload, other, packageInfo]);
}

async function withInstalledFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-native-upgrade-'));
  try {
    await mkdir(path.join(root, 'resources'));
    await writeFile(path.join(root, 'game.exe'), 'fixture');
    const archivePath = path.join(root, 'resources', 'app.asar');
    const backupPath = `${archivePath}.before-open-world-save-read`;
    const receiptPath = `${archivePath}.open-world-save-read.json`;
    const original = fixtureArchive();
    const previous = replaceAsarEntry(original, 'dist/preload/preload.js', Buffer.from('/* OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1 */ previous\nnative preload'));
    const receipt = { schemaVersion: 1, marker: 'OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1', archivePath, backupPath,
      gameVersion: '1.7.0', originalSha256: sha256(original), patchedSha256: sha256(previous),
      preloadSha256: sha256(readAsarEntry(previous, 'dist/preload/preload.js')) };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(archivePath, previous); await writeFile(backupPath, original);
    await writeFile(receiptPath, receiptBytes);
    await run({ root, archivePath, backupPath, receiptPath, original, previous, receipt, receiptBytes,
      stagedPath: path.join(root, 'upgrade.asar') });
  } finally { await rm(root, { recursive: true, force: true }); }
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
    const patched = replaceAsarEntry(original, 'dist/preload/preload.js', createNativeSaveReadPreload(readAsarEntry(original, 'dist/preload/preload.js')));
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

test('upgrading a verified installation preserves its original backup and restores exact original bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-native-upgrade-'));
  try {
    await mkdir(path.join(root, 'resources'));
    await writeFile(path.join(root, 'game.exe'), 'fixture');
    const archivePath = path.join(root, 'resources', 'app.asar');
    const backupPath = `${archivePath}.before-open-world-save-read`;
    const receiptPath = `${archivePath}.open-world-save-read.json`;
    const stagedPath = path.join(root, 'upgrade.asar');
    const original = fixtureArchive();
    const previous = replaceAsarEntry(original, 'dist/preload/preload.js', Buffer.from('/* OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1 */ previous\nnative preload'));
    const patched = replaceAsarEntry(original, 'dist/preload/preload.js', createNativeSaveReadPreload(readAsarEntry(original, 'dist/preload/preload.js')));
    const receipt = { schemaVersion: 1, marker: 'OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1', archivePath, backupPath,
      originalSha256: sha256(original), patchedSha256: sha256(previous),
      preloadSha256: sha256(readAsarEntry(previous, 'dist/preload/preload.js')) };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(archivePath, previous); await writeFile(backupPath, original);
    await writeFile(receiptPath, receiptBytes);
    const plan = await prepareNativeSaveReadPatch({ gameRoot: root, outputPath: stagedPath });
    assert.equal(plan.operation, 'upgrade');
    assert.equal(plan.receiptSha256, sha256(receiptBytes));
    assert.deepEqual(await readFile(stagedPath), patched, 'the new patch starts from the original, never stacks bootstraps');
    await applyNativeSaveReadPatch(plan);
    assert.deepEqual(await readFile(archivePath), patched);
    assert.deepEqual(await readFile(backupPath), original);
    assert.deepEqual(readAsarEntry(await readFile(archivePath), 'other.bin'), readAsarEntry(original, 'other.bin'));
    assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).patchedSha256, sha256(patched));
    await restoreNativeSaveReadPatch({ gameRoot: root });
    assert.deepEqual(await readFile(archivePath), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upgrade refuses changed native archives, backups, receipts and staged content without replacing them', async () => {
  for (const target of ['archivePath', 'backupPath', 'receiptPath', 'stagedPath']) {
    await withInstalledFixture(async fixture => {
      const plan = await prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath });
      const changed = target === 'receiptPath'
        ? Buffer.from(JSON.stringify({ ...fixture.receipt, appliedAt: 'changed after preparation' }))
        : Buffer.from('changed after preparation');
      await writeFile(fixture[target], changed);
      await assert.rejects(applyNativeSaveReadPatch(plan), /changed/, target);
      assert.deepEqual(await readFile(fixture[target]), changed);
      if (target !== 'archivePath') assert.deepEqual(await readFile(fixture.archivePath), fixture.previous);
      if (target !== 'backupPath') assert.deepEqual(await readFile(fixture.backupPath), fixture.original);
    });
  }
});

test('upgrades reject inconsistent receipts, unsupported originals and unrelated archive changes', async () => {
  await withInstalledFixture(async fixture => {
    await assert.rejects(prepareProductionPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath }), /verified Subway Builder/);
    await writeFile(fixture.receiptPath, JSON.stringify({ ...fixture.receipt, backupPath: `${fixture.backupPath}.other` }));
    await assert.rejects(prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath }), /receipt target/);
    await writeFile(fixture.receiptPath, fixture.receiptBytes);
    const changed = replaceAsarEntry(fixture.previous, 'other.bin', Buffer.from('unexpected native modification'));
    await writeFile(fixture.archivePath, changed);
    await writeFile(fixture.receiptPath, JSON.stringify({ ...fixture.receipt, patchedSha256: sha256(changed) }));
    await assert.rejects(prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath }), /unexpected changes/);
    assert.deepEqual(await readFile(fixture.archivePath), changed);
    assert.deepEqual(await readFile(fixture.backupPath), fixture.original);
  });
});

test('interrupted upgrade files are never overwritten or deleted by another operation', async () => {
  for (const suffix of ['.open-world-save-read.tmp', '.open-world-save-read.json.tmp', '.open-world-save-read.previous', '.restore.tmp']) {
    await withInstalledFixture(async fixture => {
      const plan = await prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath });
      const interruptedPath = `${fixture.archivePath}${suffix}`;
      await writeFile(interruptedPath, 'interrupted transaction');
      await assert.rejects(applyNativeSaveReadPatch(plan), /existing native patch state/);
      await assert.rejects(restoreNativeSaveReadPatch({ gameRoot: fixture.root }), /existing native patch state/);
      await assert.rejects(prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: `${fixture.stagedPath}.next` }), /existing native patch state/);
      assert.equal(await readFile(interruptedPath, 'utf8'), 'interrupted transaction');
      assert.deepEqual(await readFile(fixture.archivePath), fixture.previous);
      assert.deepEqual(await readFile(fixture.backupPath), fixture.original);
    });
  }
});

test('a failed atomic receipt replacement rolls back the archive and leaves the original backup intact', async () => {
  await withInstalledFixture(async fixture => {
    const plan = await prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath });
    const nativeRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (to === fixture.receiptPath) throw new Error('receipt publication failed');
      return nativeRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(applyNativeSaveReadPatch(plan), /receipt publication failed/); }
    finally { fs.promises.rename = nativeRename; syncBuiltinESMExports(); }
    assert.deepEqual(await readFile(fixture.archivePath), fixture.previous);
    assert.deepEqual(await readFile(fixture.backupPath), fixture.original);
    assert.deepEqual(await readFile(fixture.receiptPath), fixture.receiptBytes);
    // The failed attempt cleans only its own temporary files and is retryable.
    await applyNativeSaveReadPatch(plan);
    await restoreNativeSaveReadPatch({ gameRoot: fixture.root });
    assert.deepEqual(await readFile(fixture.archivePath), fixture.original);
  });
});

test('a game update arriving while the upgrade is staged remains untouched', async () => {
  await withInstalledFixture(async fixture => {
    const plan = await prepareNativeSaveReadPatch({ gameRoot: fixture.root, outputPath: fixture.stagedPath });
    const nativeWrite = fs.promises.writeFile;
    fs.promises.writeFile = async (filename, ...args) => {
      const result = await nativeWrite(filename, ...args);
      if (filename === `${fixture.archivePath}.open-world-save-read.tmp`) {
        await nativeWrite(fixture.archivePath, 'native update arrived');
      }
      return result;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(applyNativeSaveReadPatch(plan), /changed/); }
    finally { fs.promises.writeFile = nativeWrite; syncBuiltinESMExports(); }
    assert.equal(await readFile(fixture.archivePath, 'utf8'), 'native update arrived');
    assert.deepEqual(await readFile(fixture.backupPath), fixture.original);
    assert.deepEqual(await readFile(fixture.receiptPath), fixture.receiptBytes);
  });
});
