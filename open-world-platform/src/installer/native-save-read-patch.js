import { copyFile, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readAsarEntry, replaceAsarEntry, sha256 } from '../host/asar-entry.js';
import { installNativeSaveReadBridge } from '../host/native-save-read-bridge.js';

const PRELOAD = 'dist/preload/preload.js';
const MARKER = 'OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1';
// This opt-in compatibility patch applies only to the inspected native build.
// Game updates must be reviewed before another preload is accepted.
const SUPPORTED_PRELOAD = '19e2d0d3db1f1a82d85f4559c24f3e255beae5d455a2d7d2de55a20bbfe1c82f';

export function createNativeSaveReadPreload(preload) {
  // Keep the original script's strict semantics when adding code before its
  // directive prologue; a later "use strict" would no longer be a directive.
  const bootstrap = `"use strict";\n/* ${MARKER} */\n(${installNativeSaveReadBridge.toString()})(require('electron').contextBridge);\n`;
  return Buffer.concat([Buffer.from(bootstrap), preload]);
}

export async function prepareNativeSaveReadPatch({ gameRoot, outputPath }) {
  const root = await realpath(gameRoot);
  await stat(path.join(root, 'game.exe'));
  const archivePath = await realpath(path.join(root, 'resources', 'app.asar'));
  if (path.dirname(archivePath) !== path.join(root, 'resources')) throw new Error('Unexpected native archive target');
  const original = await readFile(archivePath);
  const packageInfo = JSON.parse(readAsarEntry(original, 'package.json'));
  const preload = readAsarEntry(original, PRELOAD);
  if (packageInfo.version !== '1.7.0' || sha256(preload) !== SUPPORTED_PRELOAD) {
    throw new Error('Native preload differs from the verified Subway Builder 1.7.0 build; no files changed');
  }
  const patched = replaceAsarEntry(original, PRELOAD, createNativeSaveReadPreload(preload));
  const stagedPath = path.resolve(outputPath);
  if (stagedPath === archivePath) throw new Error('Prepare requires a separate output path');
  await writeFile(stagedPath, patched);
  const plan = { schemaVersion: 1, marker: MARKER, archivePath, stagedPath, gameVersion: packageInfo.version,
    originalSha256: sha256(original), patchedSha256: sha256(patched), preloadSha256: sha256(readAsarEntry(patched, PRELOAD)) };
  await writeFile(`${stagedPath}.json`, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyNativeSaveReadPatch(plan) {
  if (plan?.schemaVersion !== 1 || plan.marker !== MARKER) throw new Error('Invalid native patch plan');
  const archivePath = await realpath(plan.archivePath);
  if (path.basename(archivePath) !== 'app.asar' || path.basename(path.dirname(archivePath)) !== 'resources') throw new Error('Invalid native archive target');
  const current = await readFile(archivePath), staged = await readFile(plan.stagedPath);
  if (sha256(current) !== plan.originalSha256 || sha256(staged) !== plan.patchedSha256) throw new Error('Native game or staged patch changed; prepare again');
  if (sha256(readAsarEntry(staged, PRELOAD)) !== plan.preloadSha256) throw new Error('Staged preload verification failed');
  const backupPath = `${archivePath}.before-open-world-save-read`;
  const temporaryPath = `${archivePath}.open-world-save-read.tmp`;
  const receiptPath = `${archivePath}.open-world-save-read.json`;
  for (const filename of [backupPath, temporaryPath, receiptPath]) {
    try { await stat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Refusing to replace existing native patch state: ${filename}`);
  }
  await writeFile(temporaryPath, staged, { flag: 'wx' });
  let backedUp = false;
  try {
    await rename(archivePath, backupPath); backedUp = true;
    await rename(temporaryPath, archivePath);
  } catch (error) {
    if (backedUp) await rename(backupPath, archivePath);
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const receipt = { ...plan, archivePath, backupPath, appliedAt: new Date().toISOString() };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return { archivePath, backupPath, receiptPath, sha256: sha256(await readFile(archivePath)) };
}

export async function restoreNativeSaveReadPatch({ gameRoot }) {
  const root = await realpath(gameRoot), archivePath = path.join(root, 'resources', 'app.asar');
  const receiptPath = `${archivePath}.open-world-save-read.json`;
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const backupPath = `${archivePath}.before-open-world-save-read`;
  if (receipt.archivePath !== archivePath || receipt.backupPath !== backupPath) throw new Error('Native patch receipt target differs');
  if (sha256(await readFile(archivePath)) !== receipt.patchedSha256
    || sha256(await readFile(backupPath)) !== receipt.originalSha256) throw new Error('Native game or backup changed; refusing to overwrite it');
  // The original backup remains available if copying is interrupted.
  const temporaryPath = `${archivePath}.restore.tmp`;
  await copyFile(backupPath, temporaryPath);
  await rename(temporaryPath, archivePath);
  await unlink(receiptPath);
  await unlink(backupPath);
  return { archivePath, sha256: sha256(await readFile(archivePath)) };
}
