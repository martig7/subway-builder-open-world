// node scripts/test-native-game-bundle.mjs <extracted renderer/public/index-*.js>
// This executes selected shipped functions, never the game module/application.
// The existing NEC lifecycle scenario supplies data and assertions. Its fake
// save generator, selected setters, hook registration and hook dispatch are
// replaced in memory with functions selected by AST from the installed game.
// Peripheral stubs: save-schema validation (not under test), thumbnails,
// telemetry, editor preferences, newspapers, blueprints, feature flags,
// lifetime-stat notifications, UI notifications, crossing-bell audio, and the
// scenario's existing map/demand-loading/native-load seams. Compression and
// lifecycle callback ownership/dispatch are real shipped implementations.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';

const input = process.argv[2];
if (!input) throw Error('Provide the renderer index extracted from the installed game app.asar');
const bundlePath = resolve(input);
const source = await readFile(bundlePath, 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const text = (node) => source.slice(node.start, node.end);
const declarations = ast.body.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : []);
const functions = new Map(ast.body.filter((node) => node.type === 'FunctionDeclaration').map((node) => [node.id.name, node]));
const propertyName = (node) => node.key?.value ?? node.key?.name;
function findNode(node, matches) {
  if (!node || typeof node !== 'object') return null;
  if (matches(node)) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child !== 'object') continue;
      const found = findNode(child, matches);
      if (found) return found;
    }
  }
  return null;
}

const stats = { decoderFunctions: 0, decoderRotations: 0, decoderAliases: 0,
  generateSaveCalls: 0, compressionCalls: 0, compressedPopRows: 0, nativeSaveEchoes: 0,
  hookRegistrations: {}, hookDispatches: {}, hookInvocations: {}, nativeErrors: [] };
const quietLogger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log'].map((name) => [name, () => {}]));
const context = vm.createContext({
  console: quietLogger, logger: quietLogger, Error, structuredClone,
  window: {}, localStorage: { getItem: () => null },
  v4: randomUUID, currentModId: 'local.nec-corridor-open-world',
  modErrorReporter: { record: (event) => stats.nativeErrors.push(event.message) },
  useInfrequentUpdatesStore: { getState: () => ({ constructionElevation: 0, layersToShow: [] }) },
  validateSaveFile: () => ({ valid: true, errors: [] }),
  isFeatureEnabled: () => false, isHeavyMetroLegacyCarLength: () => false,
  generateRouteThumbnail: () => undefined, newspaperService: { getArticles: () => [] },
  getSavedBlueprints: () => [], getIsTutorialActive: () => false,
  telemetry$1: { trackGameAction() {} },
  resolveCity: (code) => ({ code }), resolveCityCode: (code) => code,
  getCityUid: (city) => city.code, setLifetimeStatsCity() {},
  uiComponents: new Map(), notifyUIComponentChange() {}, stopAllCrossingBells() {},
  customSources: new Map(), customLayers: [], mapInstance: null,
  requestAnimationFrame: (callback) => queueMicrotask(callback),
});
const evaluate = (code, filename) => new vm.Script(code, { filename }).runInContext(context, { timeout: 5_000 });

// Initialize only obfuscator string tables/decoders and their table rotations.
// No imports, store creation, React mounting, Electron or game initialization
// expression is eligible. The VM receives no filesystem/network/process tools.
const decoderSource = [];
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && /^_0x/.test(node.id.name)) {
    decoderSource.push(text(node)); stats.decoderFunctions++;
  } else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
    && node.expression.callee.type === 'FunctionExpression'
    && /parseInt\(/.test(text(node)) && /shift/.test(text(node)) && /while/.test(text(node))) {
    decoderSource.push(text(node)); stats.decoderRotations++;
  } else if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      if (declaration.id.type === 'Identifier' && /^_0x/.test(declaration.id.name)
        && declaration.init?.type === 'Identifier' && /^_0x/.test(declaration.init.name)) {
        decoderSource.push(`${node.kind} ${text(declaration)};`); stats.decoderAliases++;
      }
    }
  }
}
assert.ok(stats.decoderFunctions > 0 && stats.decoderRotations > 0, 'Expected shipped string-table decoders');
evaluate(decoderSource.join('\n'), 'native-game:string-decoders');

function loadFunction(name) {
  const node = functions.get(name);
  assert.ok(node, `Shipped function ${name} was not found`);
  evaluate(text(node), `native-game:${name}`);
}
for (const name of ['CURRENT_SAVE_VERSION', 'TIMELAPSE_INTERVAL_DAYS', 'lifecycleState', 'noopUnsubscribe']) {
  const declaration = declarations.find((node) => node.id.name === name);
  assert.ok(declaration, `Shipped value ${name} was not found`);
  evaluate(`var ${text(declaration)};`, `native-game:${name}`);
}
const callbackArrays = declarations.filter((node) => /Callbacks$/.test(node.id.name)
  && node.init?.type === 'ArrayExpression' && node.init.elements.length === 0);
for (const node of callbackArrays) evaluate(`var ${text(node)};`, `native-game:${node.id.name}`);
const dispatchNames = ['GameInit', 'GameEnd', 'GameSaved', 'GameLoaded', 'CityLoad', 'MapReady', 'DayChange', 'ScheduleChange'];
for (const name of ['makeUnsubscribe', 'compressDemandData', 'compressCommuteSummary', 'compressModeChoice',
  'trimPathForStorage', 'reapplyCustomMapLayers', ...dispatchNames.map((name) => `trigger${name}`)]) loadFunction(name);
const nativeCompression = context.compressDemandData;
context.compressDemandData = (...args) => { stats.compressionCalls++; return nativeCompression(...args); };

const store = declarations.find((node) => node.id.name === 'useMainStore');
const factory = store?.init?.arguments?.[0];
assert.equal(factory?.body?.type, 'ObjectExpression', 'Expected the native store factory object');
const methods = new Map(factory.body.properties.filter((node) => node.type === 'Property')
  .map((node) => [propertyName(node), node.value]));
const createApi = functions.get('createModdingAPI');
const hookProperty = findNode(createApi, (node) => node.type === 'Property'
  && propertyName(node) === 'hooks' && node.value.type === 'ObjectExpression');
assert.ok(hookProperty, 'The native hooks registration object was not found');
const localDecoderAliases = createApi.body.body.filter((node) => node.type === 'VariableDeclaration')
  .flatMap((node) => node.declarations.filter((declaration) => /^_0x/.test(declaration.id.name)
    && declaration.init?.type === 'Identifier' && /^_0x/.test(declaration.init.name))
    .map((declaration) => `const ${text(declaration)};`));
const nativeHooks = evaluate(`(() => { ${localDecoderAliases.join('\n')} return (${text(hookProperty.value)}); })()`, 'native-game:hooks');
const selectedSetters = ['setCityCode', 'setGameMode', 'setTimeConfig', 'setFinancialHistory', 'setRouteFinancials', 'setCompletedCommutes'];
let recoveryCompressionBaseline;
let recoveryVerified = false;
const pendingCallbacks = new Set();
const harness = {
  bindState(state, counters) {
    context[factory.params[0].name] = (update) => Object.assign(state, typeof update === 'function' ? update(state) : update);
    context[factory.params[1].name] = () => state;
    for (const name of [...selectedSetters, 'generateSave']) {
      assert.ok(methods.has(name), `Shipped store action ${name} was not found`);
      state[name] = evaluate(`(${text(methods.get(name))})`, `native-game:store.${name}`);
    }
    // A real, nonempty demand row proves the shipped compressor ran through
    // its population traversal, instead of merely accepting an empty fixture.
    state.demandData.popsMap.set('native-compression-probe', {
      homeDepartureTime: 25_200, workDepartureTime: 61_200,
      lastCommute: { transitPaths: [], walking: { distance: 100, time: 100 }, modeChoice: { car: 1, transit: 0, walk: 0 } },
    });
    const nativeGenerate = state.generateSave;
    state.generateSave = (...args) => {
      counters.generateSave++; stats.generateSaveCalls++;
      const saveCallbacksBefore = stats.hookInvocations.onGameSaved ?? 0;
      const save = nativeGenerate(...args);
      stats.nativeSaveEchoes += (stats.hookInvocations.onGameSaved ?? 0) - saveCallbacksBefore;
      assert.equal(save.version, context.CURRENT_SAVE_VERSION);
      assert.equal(save.data.compressedDemandData.v, 2);
      stats.compressedPopRows = Math.max(stats.compressedPopRows, save.data.compressedDemandData.p.length);
      return save;
    };
  },
  createHooks(dispatch) {
    for (const name of dispatchNames) {
      const event = name[0].toLowerCase() + name.slice(1);
      dispatch[event] = (...args) => {
        stats.hookDispatches[name] = (stats.hookDispatches[name] ?? 0) + 1;
        context[`trigger${name}`](...args);
        // Native dispatch remains synchronous and unchanged; a test that
        // awaits this helper can then wait for callbacks' asynchronous work.
        return Promise.all([...pendingCallbacks]);
      };
    }
    return Object.fromEntries(Object.entries(nativeHooks).map(([name, register]) => [name, (callback) => {
      stats.hookRegistrations[name] = (stats.hookRegistrations[name] ?? 0) + 1;
      return register((...args) => {
        stats.hookInvocations[name] = (stats.hookInvocations[name] ?? 0) + 1;
        const result = callback(...args);
        if (result?.then) {
          pendingCallbacks.add(result);
          result.then(() => pendingCallbacks.delete(result), () => pendingCallbacks.delete(result));
        }
        return result;
      });
    }]));
  },
  recordRecoveryBaseline() { recoveryCompressionBaseline = stats.compressionCalls; },
  assertRecoveryReusedCompression() {
    assert.equal(stats.compressionCalls, recoveryCompressionBaseline, 'Second recovery must not repeat shipped demand compression');
    recoveryVerified = true;
  },
};

// Adapt only fixture construction/dispatch. Keep the existing behavioral
// assertions and its mod imports intact, so this cannot silently become a
// second implementation of the production startup/lifecycle behavior.
const fixtureUrl = new URL('../../prototype/nec-corridor/mod/tests/autosave-finance-isolation.test.js', import.meta.url);
const fixture = await readFile(fixtureUrl, 'utf8');
const fixtureAst = parse(fixture, { ecmaVersion: 'latest', sourceType: 'module' });
const edits = [];
for (const node of fixtureAst.body.filter((node) => node.type === 'ImportDeclaration')) {
  if (node.source.value === 'node:test') {
    edits.push({ start: node.start, end: node.end, value: 'const test = async (_name, run) => run();\nconst native = globalThis.__openWorldNativeBundleHarness;' });
  } else if (node.source.value.startsWith('.')) {
    edits.push({ start: node.source.start, end: node.source.end, value: JSON.stringify(new URL(node.source.value, fixtureUrl).href) });
  }
}
const testCall = fixtureAst.body.find((node) => node.type === 'ExpressionStatement' && node.expression.callee?.name === 'test');
assert.ok(testCall, 'Expected the existing NEC lifecycle scenario');
edits.push({ start: testCall.start, end: testCall.start, value: 'await ' });
const scenario = testCall.expression.arguments[1];
for (const [name, value] of [
  ['state', '\nnative.bindState(state, counters);'],
  ['generatedForRecovery', '\nnative.recordRecoveryBaseline();'],
]) {
  const declaration = findNode(scenario, (node) => node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id.name === name));
  assert.ok(declaration, `Fixture declaration ${name} was not found`);
  edits.push({ start: declaration.end, end: declaration.end, value });
}
const apiDeclaration = findNode(scenario, (node) => node.type === 'VariableDeclarator' && node.id.name === 'api');
const fixtureHooks = apiDeclaration?.init?.properties?.find((node) => propertyName(node) === 'hooks');
assert.ok(fixtureHooks, 'Fixture API hooks were not found');
edits.push({ start: fixtureHooks.value.start, end: fixtureHooks.value.end, value: 'native.createHooks(hooks)' });
const recoveryAssertion = findNode(scenario, (node) => node.type === 'ExpressionStatement'
  && node.expression.callee?.object?.name === 'assert'
  && node.expression.arguments?.some((argument) => argument.value === 'template reuse must capture current live state'));
assert.ok(recoveryAssertion, 'Fixture recovery assertion was not found');
edits.push({ start: recoveryAssertion.end, end: recoveryAssertion.end, value: '\nnative.assertRecoveryReusedCompression();' });
let adaptedFixture = fixture;
for (const edit of edits.sort((left, right) => right.start - left.start)) {
  adaptedFixture = adaptedFixture.slice(0, edit.start) + edit.value + adaptedFixture.slice(edit.end);
}
globalThis.__openWorldNativeBundleHarness = harness;
try {
  await import(`data:text/javascript;base64,${Buffer.from(adaptedFixture).toString('base64')}`);
  assert.equal(recoveryVerified, true);
  assert.ok(stats.compressedPopRows > 0);
  assert.ok(stats.nativeSaveEchoes > 0, 'Native generateSave must dispatch its save echo into the mod');
  assert.ok(stats.hookInvocations.onGameInit > 0 && stats.hookInvocations.onDayChange > 0);
  assert.deepEqual(stats.nativeErrors, []);
  for (const name of Object.keys(stats.hookRegistrations)) {
    const arrayName = name.slice(2, 3).toLowerCase() + name.slice(3) + 'Callbacks';
    assert.ok(Array.isArray(context[arrayName]), `Native callback array for ${name} must exist`);
    assert.equal(context[arrayName].length, 0, `${name} must unsubscribe on disposal`);
  }
  console.log(JSON.stringify({
    bundlePath, bundleSha256: createHash('sha256').update(source).digest('hex'),
    scenario: fileURLToPath(fixtureUrl), schemaValidation: 'stubbed; not under test',
    ...stats, recoveryTemplateReusedWithoutCompression: recoveryVerified,
  }, null, 2));
  console.log('PASS: shipped save compression, lifecycle hooks, recovery reuse, restart invalidation, and unsubscription');
} catch (error) {
  console.error('FAIL: isolated native game-bundle scenario:', error.message);
  console.error(JSON.stringify({ ...stats, actual: error.actual, expected: error.expected }, null, 2));
  process.exitCode = 1;
} finally {
  delete globalThis.__openWorldNativeBundleHarness;
}
