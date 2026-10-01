import { constants } from 'node:fs';
import { copyFile, lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readAsarEntry, replaceAsarEntry, sha256 } from '../host/asar-entry.js';
import { installNativeSaveReadBridge } from '../host/native-save-read-bridge.js';

const PRELOAD = 'dist/preload/preload.js';
const MARKER = 'OPEN_WORLD_NATIVE_SAVE_READ_PATCH_V1';
const MENU_MARKER = 'OPEN_WORLD_NATIVE_LOAD_MENU_V1';
// Game updates require reviewing both native entries before extending this list.
const SUPPORTED_BUILDS = Object.freeze([{ version: '1.7.0',
  preloadSha256: '19e2d0d3db1f1a82d85f4559c24f3e255beae5d455a2d7d2de55a20bbfe1c82f',
  rendererPath: 'dist/renderer/public/index-CM0DI1Ho.js',
  rendererSha256: '99fd5ed94f0c77636f32fe1f21c6165bc6649ea528beb03bee7ad87d4b8bd67d' },
{ version: '1.7.2',
  preloadSha256: '0b095373ae605b17dee6c0cb105898ec8fd41a108a6dcc128fa449760f7367ce',
  rendererPath: 'dist/renderer/public/index-NqqqjH9_.js',
  rendererSha256: '7578256076ff13e3bada8801af26e56c336f83a5c193c9d92c2b9ef0f231240c' }]);

export function createNativeSaveReadPreload(preload) {
  // Preserve the original script's strict semantics before adding a bootstrap.
  const bootstrap = `"use strict";\n/* ${MARKER} */\n(${installNativeSaveReadBridge.toString()})(require('electron').contextBridge);\n`;
  return Buffer.concat([Buffer.from(bootstrap), preload]);
}

const NATIVE_LOAD_MENU = `      const fullSave = await loadGame(save2.id, save2.autosaveId);
      if (!fullSave) {
        throw new Error("Failed to load save - file may be corrupted or in an unsupported format");
      }
      const saveCityCode = inferCityCodeFromSave(fullSave);
      fullSave.cityCode = saveCityCode;
      if (window.electron?.setPendingSave) {
        await window.electron.setPendingSave(fullSave);
      }
      goToGame({ city: saveCityCode, resume: true });`;

/** The verified 1.7.0 and 1.7.2 Load Game menus have the file path and autosave ID.
 * Stage that file in the main process, exactly as the native Resume handler does. */
export function createNativeSaveReadRenderer(renderer) {
  const source = renderer.toString('utf8');
  const handlerStart = source.indexOf('  async function handleLoadSave(save2) {');
  const handlerEnd = source.indexOf('  async function handleDeleteSave(save2) {', handlerStart);
  if (handlerStart < 0 || handlerEnd < 0 || source.indexOf('  async function handleLoadSave(save2) {', handlerStart + 1) >= 0) {
    throw new Error('Could not find the verified Load Game handler');
  }
  const handler = source.slice(handlerStart, handlerEnd);
  if (!handler.includes(NATIVE_LOAD_MENU) || handler.indexOf(NATIVE_LOAD_MENU) !== handler.lastIndexOf(NATIVE_LOAD_MENU)) {
    throw new Error('Native renderer differs from the verified Load Game handler');
  }
  const replacement = `      /* ${MENU_MARKER} */
      if (window.electron?.loadAndSetPendingSave) {
        const result = await window.electron.loadAndSetPendingSave(save2.id, save2.autosaveId);
        if (result?.success !== true) throw new Error(result?.error || "Failed to load save - file may be corrupted or in an unsupported format");
        goToGame({ city: result.cityCode || save2.cityCode || "NYC", resume: true });
      } else {
${NATIVE_LOAD_MENU.split('\n').map(line => `  ${line}`).join('\n')}
      }`;
  return Buffer.from(source.slice(0, handlerStart) + handler.replace(NATIVE_LOAD_MENU, replacement) + source.slice(handlerEnd));
}

function patchPaths(archivePath) {
  const receiptPath = `${archivePath}.open-world-save-read.json`;
  return { archivePath, backupPath: `${archivePath}.before-open-world-save-read`, receiptPath,
    temporaryPath: `${archivePath}.open-world-save-read.tmp`,
    receiptTemporaryPath: `${receiptPath}.tmp`,
    previousPath: `${archivePath}.open-world-save-read.previous`,
    restoreTemporaryPath: `${archivePath}.restore.tmp` };
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function requireAbsent(filenames) {
  for (const filename of filenames) if (await exists(filename)) {
    throw new Error(`Refusing to replace existing native patch state: ${filename}`);
  }
}

async function readRegularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular native patch file: ${filename}`);
  return readFile(filename);
}

function requirePlan(plan) {
  if (plan?.schemaVersion !== 1 || plan.marker !== MARKER
    || !['install', 'upgrade'].includes(plan.operation ?? 'install')
    || Boolean(plan.rendererPath) !== Boolean(plan.rendererSha256)) throw new Error('Invalid native patch plan');
}

/** The CLI uses the fixed production policy below. A separate policy lets
 * filesystem integration tests exercise tiny ASARs without shipping game code. */
export function createNativeSaveReadPatchInstaller({ supportedBuilds = SUPPORTED_BUILDS } = {}) {
  const builds = supportedBuilds.map(build => ({ ...build }));
  function verifyOriginal(original) {
    const packageInfo = JSON.parse(readAsarEntry(original, 'package.json'));
    const preload = readAsarEntry(original, PRELOAD);
    const build = builds.find(candidate => candidate.version === packageInfo.version
      && candidate.preloadSha256 === sha256(preload)
      && (!candidate.rendererPath || candidate.rendererSha256 === sha256(readAsarEntry(original, candidate.rendererPath))));
    if (!build) throw new Error(`Native preload or renderer differs from the verified Subway Builder builds (${builds.map(candidate => candidate.version).join(', ')}); no files changed`);
    return { packageInfo, preload, build };
  }
  function verifyReplacement(original, patched, preloadHash, rendererPath, rendererHash) {
    const preload = readAsarEntry(patched, PRELOAD);
    if (sha256(preload) !== preloadHash) throw new Error('Staged preload verification failed');
    const nativePreload = readAsarEntry(original, PRELOAD);
    if (!preload.subarray(-nativePreload.length).equals(nativePreload)
      || !preload.subarray(0, 128).toString().includes(`/* ${MARKER} */`)) {
      throw new Error('Native patch contains an unexpected preload bootstrap');
    }
    let expected = replaceAsarEntry(original, PRELOAD, preload);
    if (rendererPath && rendererHash) {
      const renderer = readAsarEntry(patched, rendererPath);
      if (sha256(renderer) !== rendererHash
        || !renderer.equals(createNativeSaveReadRenderer(readAsarEntry(original, rendererPath)))) {
        throw new Error('Staged renderer verification failed');
      }
      expected = replaceAsarEntry(expected, rendererPath, renderer);
    }
    if (!expected.equals(patched)) throw new Error('Native patch contains unexpected changes outside the verified entries');
  }
  async function installedState(paths, current) {
    const receiptBytes = await readRegularFile(paths.receiptPath);
    const receipt = JSON.parse(receiptBytes);
    requirePlan(receipt);
    if (receipt.archivePath !== paths.archivePath || receipt.backupPath !== paths.backupPath) {
      throw new Error('Native patch receipt target differs');
    }
    const original = await readRegularFile(paths.backupPath);
    if (sha256(current) !== receipt.patchedSha256 || sha256(original) !== receipt.originalSha256) {
      throw new Error('Native game or backup changed; refusing to overwrite it');
    }
    const verified = verifyOriginal(original);
    if (receipt.gameVersion != null && receipt.gameVersion !== verified.packageInfo.version) {
      throw new Error('Native patch receipt game version differs');
    }
    if (receipt.rendererPath && receipt.rendererPath !== verified.build.rendererPath) {
      throw new Error('Native patch receipt renderer target differs');
    }
    verifyReplacement(original, current, receipt.preloadSha256, receipt.rendererPath, receipt.rendererSha256);
    return { original, receipt, receiptBytes, ...verified };
  }
  async function noInterruptedTransaction(paths) {
    await requireAbsent([paths.temporaryPath, paths.receiptTemporaryPath, paths.previousPath, paths.restoreTemporaryPath]);
  }

  async function prepareNativeSaveReadPatch({ gameRoot, outputPath }) {
    const root = await realpath(gameRoot);
    await stat(path.join(root, 'game.exe'));
    const archivePath = path.join(root, 'resources', 'app.asar');
    if (await realpath(archivePath) !== archivePath) throw new Error('Unexpected native archive target');
    const paths = patchPaths(archivePath);
    await noInterruptedTransaction(paths);
    const current = await readRegularFile(archivePath);
    const upgrade = await exists(paths.receiptPath);
    if (!upgrade) await requireAbsent([paths.backupPath]);
    const verified = upgrade ? await installedState(paths, current)
      : { original: current, ...verifyOriginal(current) };
    let patched = replaceAsarEntry(verified.original, PRELOAD, createNativeSaveReadPreload(verified.preload));
    if (verified.build.rendererPath) {
      patched = replaceAsarEntry(patched, verified.build.rendererPath,
        createNativeSaveReadRenderer(readAsarEntry(verified.original, verified.build.rendererPath)));
    }
    const stagedPath = path.resolve(outputPath);
    const stagedParent = await realpath(path.dirname(stagedPath));
    const resolvedStage = path.join(stagedParent, path.basename(stagedPath));
    if ([resolvedStage, `${resolvedStage}.json`].some(filename => Object.values(paths).includes(filename))) {
      throw new Error('Prepare requires separate output paths outside native patch state');
    }
    await requireAbsent([stagedPath, `${stagedPath}.json`]);
    const plan = { schemaVersion: 1, marker: MARKER, operation: upgrade ? 'upgrade' : 'install',
      archivePath, stagedPath, gameVersion: verified.packageInfo.version,
      currentSha256: sha256(current), originalSha256: sha256(verified.original),
      patchedSha256: sha256(patched), preloadSha256: sha256(readAsarEntry(patched, PRELOAD)),
      ...(verified.build.rendererPath ? { rendererPath: verified.build.rendererPath,
        rendererSha256: sha256(readAsarEntry(patched, verified.build.rendererPath)) } : {}),
      ...(upgrade ? { receiptSha256: sha256(verified.receiptBytes) } : {}) };
    await writeFile(stagedPath, patched, { flag: 'wx' });
    try { await writeFile(`${stagedPath}.json`, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { await unlink(stagedPath); throw error; }
    return plan;
  }

  async function applyNativeSaveReadPatch(plan) {
    requirePlan(plan);
    const archivePath = await realpath(plan.archivePath);
    if (archivePath !== path.resolve(plan.archivePath) || path.basename(archivePath) !== 'app.asar'
      || path.basename(path.dirname(archivePath)) !== 'resources') throw new Error('Invalid native archive target');
    const paths = patchPaths(archivePath), upgrade = plan.operation === 'upgrade';
    await noInterruptedTransaction(paths);
    if (!upgrade) await requireAbsent([paths.backupPath, paths.receiptPath]);
    const current = await readRegularFile(archivePath), staged = await readRegularFile(plan.stagedPath);
    if (sha256(current) !== (plan.currentSha256 ?? plan.originalSha256)
      || sha256(staged) !== plan.patchedSha256) throw new Error('Native game or staged patch changed; prepare again');
    const verified = upgrade ? await installedState(paths, current)
      : { original: current, ...verifyOriginal(current) };
    if (sha256(verified.original) !== plan.originalSha256
      || (upgrade && sha256(verified.receiptBytes) !== plan.receiptSha256)) {
      throw new Error('Native backup or receipt changed; prepare again');
    }
    if (plan.rendererPath !== verified.build.rendererPath) throw new Error('Staged renderer target differs from verified game');
    verifyReplacement(verified.original, staged, plan.preloadSha256, plan.rendererPath, plan.rendererSha256);
    const receipt = { ...plan, archivePath, backupPath: paths.backupPath, appliedAt: new Date().toISOString() };
    // The exclusive temporary file also excludes a concurrent apply. Never
    // remove a pre-existing temp: it may belong to an interrupted installation.
    await writeFile(paths.temporaryPath, staged, { flag: 'wx' });
    let receiptTemporaryOwned = false, movedCurrent = false, publishedReceipt = false;
    const rollbackPath = upgrade ? paths.previousPath : paths.backupPath;
    try {
      await writeFile(paths.receiptTemporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
      receiptTemporaryOwned = true;
      // Writing a large staged archive may yield long enough for a game update
      // or another completed operation. Recheck after owning the temp files.
      if (sha256(await readRegularFile(archivePath)) !== sha256(current)
        || (upgrade && (sha256(await readRegularFile(paths.receiptPath)) !== plan.receiptSha256
          || sha256(await readRegularFile(paths.backupPath)) !== plan.originalSha256))) {
        throw new Error('Native game, backup or receipt changed during staging; prepare again');
      }
      await requireAbsent(upgrade ? [paths.previousPath] : [paths.backupPath, paths.receiptPath]);
      // Retain the previous installation until the new receipt is committed.
      await rename(archivePath, rollbackPath); movedCurrent = true;
      await rename(paths.temporaryPath, archivePath);
      await rename(paths.receiptTemporaryPath, paths.receiptPath);
      receiptTemporaryOwned = false; publishedReceipt = true;
    } catch (error) {
      if (movedCurrent && !publishedReceipt) {
        try { await rename(rollbackPath, archivePath); }
        catch (rollbackError) { error.rollbackError = rollbackError; throw error; }
      }
      await unlink(paths.temporaryPath).catch(() => {});
      if (receiptTemporaryOwned) await unlink(paths.receiptTemporaryPath).catch(() => {});
      throw error;
    }
    if (upgrade) await unlink(paths.previousPath);
    return { archivePath, backupPath: paths.backupPath, receiptPath: paths.receiptPath,
      operation: upgrade ? 'upgrade' : 'install', sha256: sha256(await readRegularFile(archivePath)) };
  }

  async function restoreNativeSaveReadPatch({ gameRoot }) {
    const root = await realpath(gameRoot), archivePath = path.join(root, 'resources', 'app.asar');
    const paths = patchPaths(archivePath);
    await noInterruptedTransaction(paths);
    const current = await readRegularFile(archivePath);
    await installedState(paths, current);
    // The exact original remains available if copying or replacement fails.
    await copyFile(paths.backupPath, paths.restoreTemporaryPath, constants.COPYFILE_EXCL);
    await rename(paths.restoreTemporaryPath, archivePath);
    await unlink(paths.receiptPath);
    await unlink(paths.backupPath);
    return { archivePath, sha256: sha256(await readRegularFile(archivePath)) };
  }

  return { prepareNativeSaveReadPatch, applyNativeSaveReadPatch, restoreNativeSaveReadPatch };
}

const production = createNativeSaveReadPatchInstaller();
export const prepareNativeSaveReadPatch = production.prepareNativeSaveReadPatch;
export const applyNativeSaveReadPatch = production.applyNativeSaveReadPatch;
export const restoreNativeSaveReadPatch = production.restoreNativeSaveReadPatch;
