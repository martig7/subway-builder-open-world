// node scripts/test-native-save-bundle.mjs <extracted renderer index> <extracted preload>
// Run the shipped preload and selected Load Game functions in
// isolated VMs. Electron IPC, the DOM, timers, navigation and notifications are
// inert fixtures. No native main process, application, filesystem or IPC runs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { readAsarEntry, sha256 } from '../src/host/asar-entry.js';
import { createNativeSaveReadPreload, createNativeSaveReadRenderer, prepareNativeSaveReadPatch } from '../src/installer/native-save-read-patch.js';

if (!process.argv[2] || !process.argv[3]) throw Error('Provide the extracted renderer index and preload');
const rendererPath = resolve(process.argv[2]), preloadPath = resolve(process.argv[3]);
const gameVersion = process.argv[4] ?? '1.7.2';
const [rendererBytes, preloadBytes] = await Promise.all([readFile(rendererPath), readFile(preloadPath)]);
const renderer = rendererBytes.toString('utf8');
const ast = parse(renderer, { ecmaVersion: 'latest', sourceType: 'module' });
const nativeText = node => renderer.slice(node.start, node.end);
const declarations = ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : []);
const functions = new Map(ast.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, node]));
function findFunctions(node, name, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    if (child && typeof child === 'object') findFunctions(child, name, found);
  }
  return found;
}
const handlers = findFunctions(ast, 'handleLoadSave');
assert.equal(handlers.length, 1, 'Require one shipped Load Game handler');
const nativeHandler = nativeText(handlers[0]);
const patchedRenderer = createNativeSaveReadRenderer(rendererBytes).toString('utf8');
const patchedHandlerStart = patchedRenderer.indexOf('  async function handleLoadSave(save2) {');
const patchedHandlerEnd = patchedRenderer.indexOf('  async function handleDeleteSave(save2) {', patchedHandlerStart);
const patchedHandler = patchedRenderer.slice(patchedHandlerStart, patchedHandlerEnd);
assert.ok(patchedHandler.includes('OPEN_WORLD_NATIVE_LOAD_MENU_V1'));

// Only the shipped obfuscator's tables/decoders, rotations and aliases can run.
// This omits renderer imports, store creation, React, Electron and mounting.
const decoders = [];
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && /^_0x/.test(node.id.name)) decoders.push(nativeText(node));
  else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
    && node.expression.callee.type === 'FunctionExpression'
    && /parseInt\(/.test(nativeText(node)) && /shift/.test(nativeText(node)) && /while/.test(nativeText(node))) decoders.push(nativeText(node));
  else if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) {
    if (declaration.id.type === 'Identifier' && /^_0x/.test(declaration.id.name)
      && declaration.init?.type === 'Identifier' && /^_0x/.test(declaration.init.name)) {
      decoders.push(`${node.kind} ${nativeText(declaration)};`);
    }
  }
}
assert.ok(decoders.length > 0, 'Require shipped string-table decoders');
const quiet = Object.fromEntries(['log', 'info', 'error', 'warn', 'debug'].map(key => [key, () => {}]));
const save = {
  id: 'selected.metro', cityCode: 'JP_PREF_12', gameSessionId: 'native-session',
  data: { routes: [{ id: 'route' }], tracks: [{ id: 'track' }], trains: [{ id: 'train' }],
    reliabilityHistory: { route: [{ timestamp: 100, onTime: 4, delayed: 1 }] } },
};

function preloadHarness(patched = false) {
  const calls = [], crossings = [], registered = new Map();
  let pending = save, stageFailure = null;
  const main = vm.createContext({ console: quiet, performance, window: null });
  main.window = main;
  const isolated = vm.createContext({ console: quiet, performance, window: {},
    crypto: { getRandomValues: array => array.fill(0) },
    document: { readyState: 'loading', createElement: () => ({ getContext: () => null }), addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {},
  });
  isolated.window.addEventListener = () => {};
  const isSaveGraph = value => Boolean(value && typeof value === 'object'
    && (value.data?.tracks || value.data?.data?.tracks));
  const cloneIntoIsolated = value => {
    isolated.fixtureJson = JSON.stringify(value);
    return vm.runInContext('JSON.parse(fixtureJson)', isolated);
  };
  const electron = {
    ipcRenderer: {
      send() {}, on(name, fn) { registered.set(name, fn); }, removeListener() {}, removeAllListeners() {},
      async invoke(channel, ...args) {
        calls.push([channel, ...args]);
        if (channel === 'get-pending-save') return cloneIntoIsolated({ success: true, data: pending });
        if (channel === 'load-game-from-path') return cloneIntoIsolated({ success: true, data: save });
        if (channel === 'set-pending-save') { pending = args[0]; return cloneIntoIsolated({ success: true }); }
        if (channel === 'remove-pending-save') { pending = null; return cloneIntoIsolated({ success: true }); }
        if (channel === 'load-and-set-pending-save') {
          if (stageFailure) return cloneIntoIsolated({ success: false, error: stageFailure });
          pending = save;
          return cloneIntoIsolated({ success: true, cityCode: save.cityCode, hasRoutes: true, hasTracks: true });
        }
        return cloneIntoIsolated({ success: true });
      },
    },
    contextBridge: {
      exposeInMainWorld(key, api) {
        main[key] = Object.fromEntries(Object.entries(api).map(([name, value]) => [name,
          typeof value === 'function' ? async (...args) => {
            const result = await value(...args);
            crossings.push({ name, graph: args.some(isSaveGraph) || isSaveGraph(result) });
            return structuredClone(result);
          } : structuredClone(value)]));
      },
      executeInMainWorld({ func, args }) {
        main.bridgeArgs = args;
        return vm.runInContext(`(${func.toString()})(...bridgeArgs)`, main, { timeout: 5_000 });
      },
    },
  };
  isolated.require = module => { assert.equal(module, 'electron'); return electron; };
  vm.runInContext((patched ? createNativeSaveReadPreload(preloadBytes) : preloadBytes).toString('utf8'), isolated,
    { filename: preloadPath, timeout: 5_000 });
  assert.equal(typeof main.electron?.getPendingSave, 'function');
  assert.equal(typeof main.electron?.loadAndSetPendingSave, 'function');
  assert.equal(typeof main.electron?.loadGameFromPath, 'function');
  calls.length = 0; // Exclude inert preload startup registration from save operations.
  return { main, calls, crossings, failStage: error => { stageFailure = error; } };
}

const native = preloadHarness();
assert.deepEqual(await native.main.electron.getPendingSave(), { success: true, data: save });
assert.equal(native.crossings.at(-1).graph, true, 'Native pending read still transfers the full graph');
assert.equal(native.main.electron.__openWorldNativeSaveReadVersion, undefined, 'Native game has no replacement transport');
await native.main.electron.loadAndSetPendingSave('selected.metro', 'auto-1');
assert.deepEqual(native.calls.at(-1), ['load-and-set-pending-save', 'selected.metro', 'auto-1']);
assert.equal(native.crossings.at(-1).graph, false, 'Existing native Resume staging returns compact metadata');

const patched = preloadHarness(true);
assert.equal(patched.main.electron.__openWorldNativeSaveReadVersion, 'native-save-read-json-v2');
assert.deepEqual(structuredClone(await patched.main.electron.getPendingSave()), { success: true, data: save });
assert.equal(patched.crossings.at(-1).graph, false, 'Patched pending read transfers text and preserves native save fields');
const info = await patched.main.electron.__openWorldGetPendingSaveInfo();
assert.equal(info.data.gameSessionId, save.gameSessionId);
assert.equal(Object.hasOwn(info.data, 'data'), false);

function menuHarness(host, source, useStaging = true) {
  const calls = [];
  const context = host.main;
  // Staging metadata is supplied by the inert main-process fixture. The native
  // preload, load/loadGame functions and menu handler are shipped code.
  if (!useStaging) delete context.electron.loadAndSetPendingSave;
  Object.assign(context, { loadingSaveId: null, logger: quiet, log() {},
    setLoadingSaveId: value => { context.loadingSaveId = value; calls.push(['loading', value]); },
    playClickAlt() {}, inferCityCodeFromSave: value => value.cityCode,
    goToGame: value => calls.push(['navigate', structuredClone(value)]),
    toast2: value => calls.push(['toast', structuredClone(value)]),
  });
  vm.runInContext(decoders.join('\n'), context, { timeout: 5_000 });
  for (const name of ['load', 'loadGame']) {
    assert.ok(functions.has(name), `Require shipped ${name}`);
    vm.runInContext(nativeText(functions.get(name)), context, { timeout: 5_000 });
  }
  // Bind exactly the dependency exported by the native save-service module.
  const service = declarations.find(node => node.id.name === '_0x3c4bfa');
  assert.ok(service && nativeText(service).includes('  load,'), 'Require shipped save-service load export');
  context._0x3c4bfa = { load: context.load };
  vm.runInContext(`${source}\nglobalThis.testLoadSave = handleLoadSave;`, context, { timeout: 5_000 });
  return { calls, run: summary => context.testLoadSave(summary), context };
}
const summary = { id: 'selected.metro', autosaveId: 'auto-1', cityCode: 'JP_PREF_12' };
const originalHost = preloadHarness(), originalMenu = menuHarness(originalHost, nativeHandler);
await originalMenu.run(summary);
assert.deepEqual(originalHost.calls.filter(call => /save|game-from-path/.test(call[0])).map(call => call[0]),
  ['load-game-from-path', 'set-pending-save']);
assert.equal(originalHost.crossings.filter(call => call.graph).length, 2, 'Native Load Game makes two full graph crossings before navigation');

const improvedHost = preloadHarness(true), improvedMenu = menuHarness(improvedHost, patchedHandler);
await improvedMenu.run(summary);
assert.deepEqual(improvedHost.calls, [['load-and-set-pending-save', summary.id, summary.autosaveId]]);
assert.equal(improvedHost.crossings.filter(call => call.graph).length, 0);
assert.deepEqual(improvedMenu.calls, [['loading', summary.id], ['navigate', { city: save.cityCode, resume: true }], ['loading', null]]);
improvedMenu.context.loadingSaveId = 'already-loading';
await improvedMenu.run(summary);
assert.equal(improvedHost.calls.length, 1, 'Native busy guard remains intact');

const failedHost = preloadHarness(true), failedMenu = menuHarness(failedHost, patchedHandler);
failedHost.failStage('corrupt fixture');
await failedMenu.run(summary);
assert.equal(failedMenu.calls.some(call => call[0] === 'navigate'), false);
assert.equal(failedMenu.calls.find(call => call[0] === 'toast')[1].description, 'corrupt fixture');
assert.equal(failedMenu.calls.at(-1)[1], null);

const fallbackHost = preloadHarness(), fallbackMenu = menuHarness(fallbackHost, patchedHandler, false);
await fallbackMenu.run(summary);
assert.equal(fallbackHost.crossings.filter(call => call.graph).length, 2);
assert.deepEqual(fallbackMenu.calls.find(call => call[0] === 'navigate')[1], { city: save.cityCode, resume: true });

// Exercise the production checksum policy against a disposable archive carrying
// the actual reviewed entries. This never prepares or modifies the installed game.
const rendererEntry = `dist/renderer/public/${basename(rendererPath)}`;
const packageBytes = Buffer.from(JSON.stringify({ version: gameVersion }));
const unrelatedBytes = Buffer.from('unrelated audit entry');
const contents = [preloadBytes, rendererBytes, packageBytes, unrelatedBytes];
let offset = 0;
const entries = contents.map(bytes => { const entry = { offset: String(offset), size: bytes.length }; offset += bytes.length; return entry; });
const archiveHeader = { files: {
  dist: { files: { preload: { files: { 'preload.js': entries[0] } }, renderer: { files: { public: { files: { [basename(rendererPath)]: entries[1] } } } } } },
  'package.json': entries[2], 'unrelated.bin': entries[3],
} };
const headerBytes = Buffer.from(JSON.stringify(archiveHeader)), headerSize = 4 + Math.ceil(headerBytes.length / 4) * 4;
const prefix = Buffer.alloc(12 + headerSize);
prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize + 4, 4); prefix.writeUInt32LE(headerSize, 8);
prefix.writeUInt32LE(headerBytes.length, 12); headerBytes.copy(prefix, 16);
const originalArchive = Buffer.concat([prefix, ...contents]);
const auditRoot = await mkdtemp(join(dirname(preloadPath), 'save-read-policy-audit-'));
try {
  await mkdir(join(auditRoot, 'resources'));
  await writeFile(join(auditRoot, 'game.exe'), 'inert fixture');
  await writeFile(join(auditRoot, 'resources', 'app.asar'), originalArchive);
  const plan = await prepareNativeSaveReadPatch({ gameRoot: auditRoot, outputPath: join(auditRoot, 'reviewed.asar') });
  assert.equal(plan.gameVersion, gameVersion);
  assert.equal(plan.rendererPath, rendererEntry);
  const staged = await readFile(plan.stagedPath);
  assert.deepEqual(readAsarEntry(staged, 'dist/preload/preload.js'), createNativeSaveReadPreload(preloadBytes));
  assert.deepEqual(readAsarEntry(staged, rendererEntry), createNativeSaveReadRenderer(rendererBytes));
  assert.deepEqual(readAsarEntry(staged, 'unrelated.bin'), unrelatedBytes);
  assert.deepEqual(await readFile(join(auditRoot, 'resources', 'app.asar')), originalArchive);
} finally { await rm(auditRoot, { recursive: true, force: true }); }

console.log(JSON.stringify({ rendererPath, preloadPath, rendererSha256: sha256(rendererBytes), preloadSha256: sha256(preloadBytes),
  nativePendingReadGraphCrossings: 1, patchedPendingReadGraphCrossings: 0,
  nativeLoadMenuGraphCrossings: 2, patchedLoadMenuGraphCrossings: 0,
  nativePreloadExecuted: true, shippedLoadFunctionsExecuted: ['load', 'loadGame', 'handleLoadSave'],
  failureAndFallbackVerified: true, productionChecksumPolicyVerified: true, installedGameModified: false,
  mainProcessExecuted: false }, null, 2));
