// node scripts/test-native-game-render-routing.mjs <renderer index> <GameMain> [baseline renderer index]
// Execute selected shipped search/picking functions and decoder tables only.
// No game module, store factory, UI mounting, Electron, network or GPU runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { queryNativeDirectedTrackGraph } from '../src/runtime/native-directed-track-search.js';
import { installMovementDeckVisibilityGuard } from '../src/runtime/ui/geographic-context-overlay.js';

const [indexPath, gamePath, baselinePath] = process.argv.slice(2);
if (!indexPath || !gamePath) throw Error('Provide the extracted renderer index and GameMain bundle');
const propertyName = node => node.key?.value ?? node.key?.name;

async function loadBundle(path, globals = {}) {
  const source = await readFile(resolve(path), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const text = node => source.slice(node.start, node.end);
  const context = vm.createContext(globals);
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 5_000 });
  const decoderSource = [];
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && /^_0x/.test(node.id.name)) decoderSource.push(text(node));
    else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
      && node.expression.callee.type === 'FunctionExpression'
      && /parseInt\(/.test(text(node)) && /shift/.test(text(node)) && /while/.test(text(node))) decoderSource.push(text(node));
    else if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier' && /^_0x/.test(declaration.id.name)
          && declaration.init?.type === 'Identifier' && /^_0x/.test(declaration.init.name)) decoderSource.push(`${node.kind} ${text(declaration)};`);
      }
    }
  }
  evaluate(decoderSource.join('\n'));
  const functions = new Map(ast.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, node]));
  const declarations = ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : []);
  return {
    source, ast, text, context, evaluate, declarations,
    hash: createHash('sha256').update(source).digest('hex'),
    loadFunction(name) { const node = functions.get(name); assert.ok(node, `Missing shipped ${name}`); evaluate(text(node)); },
    loadValue(name) { const node = declarations.find(node => node.id.name === name); assert.ok(node, `Missing shipped ${name}`); evaluate(`var ${text(node)};`); },
  };
}

async function loadRouting(path) {
  const bundle = await loadBundle(path, { getCoordPrecision: () => 6 });
  for (const name of ['roundTo$1', 'roundCoordinate', 'coordsEqual', 'strCoords', 'normalizeBearing',
    'reconstructStNodePath', 'chainContainsFlip', 'getPathBetweenStNodes', 'getFlipAwarePath']) bundle.loadFunction(name);
  for (const name of ['PASS_THROUGH_PLATFORM_PENALTY', 'TURNBACK_WRONG_WAY_PENALTY', 'DIRECTION_FLIP_PENALTY', 'DIRECTION_FLIP_MAX_TURN']) bundle.loadValue(name);
  if (bundle.declarations.some(node => node.id.name === 'CROSSOVER_LANE_CHANGE_PENALTY')) bundle.loadValue('CROSSOVER_LANE_CHANGE_PENALTY');
  const heap = bundle.ast.body.find(node => node.type === 'ClassDeclaration' && node.id.name === 'FrontierHeap');
  assert.ok(heap, 'Missing shipped frontier heap');
  bundle.evaluate(bundle.text(heap));
  // Some shipped builds reference normalizeBearing through a utility namespace.
  // Supply only that selected shipped function, not the whole utility module.
  for (const node of bundle.declarations.filter(node => /Object\.freeze/.test(bundle.text(node)) && /\bnormalizeBearing\s*,/.test(bundle.text(node)))) {
    bundle.evaluate(`var ${node.id.name} = { normalizeBearing, coordsEqual, roundCoordinate, strCoords };`);
  }
  return bundle;
}

const native = await loadRouting(indexPath);
const edge = (coordsString, trackId, extra = {}) => ({ coordsString, trackId, trackLength: 100, ...extra });
const graph = new Map([
  ['0-0', [edge('1-0', 'cross-1', { trackIsCrossover: true }), edge('2-0', 'straight-1')]],
  ['1-0', [edge('4-0', 'cross-2', { trackIsCrossover: true })]],
  ['2-0', [edge('3-0', 'straight-2')]], ['3-0', [edge('4-0', 'straight-3')]],
]);
const nativeQuery = bundle => bundle.context.getPathBetweenStNodes({ trackGraph: graph, platformTrackIds: new Set(), startCoords: [0, 0], endCoords: [4, 0] });
const ids = path => Array.from(path, segment => segment.trackId);
assert.deepEqual(ids(nativeQuery(native)), ['straight-1', 'straight-2', 'straight-3']);
assert.deepEqual(ids(native.context.getFlipAwarePath({ trackGraph: graph, platformTrackIds: new Set(), startCoordsStr: '0-0', endCoordsStr: '4-0' })), ['straight-1', 'straight-2', 'straight-3']);
assert.deepEqual(ids(queryNativeDirectedTrackGraph(graph, new Set(), '0-0', '4-0', { withPath: true }).path), ids(nativeQuery(native)));
assert.throws(() => native.context.getPathBetweenStNodes({ trackGraph: graph, platformTrackIds: new Set(), startCoords: [4, 0], endCoords: [0, 0] }), /No valid path/);
let baselineChoice = null;
if (baselinePath) {
  const baseline = await loadRouting(baselinePath);
  baselineChoice = ids(nativeQuery(baseline));
  assert.deepEqual(baselineChoice, ['cross-1', 'cross-2']);
  assert.deepEqual(ids(baseline.context.getFlipAwarePath({ trackGraph: graph, platformTrackIds: new Set(), startCoordsStr: '0-0', endCoordsStr: '4-0' })), baselineChoice);
}

const routeIds = ['outside', 'split', 'inside'];
const nativeState = { routes: routeIds.map(id => ({ id, tempParentId: null })), portolanDiagram: { bands: { fixture: { routes: routeIds.map(id => [id]) } } } };
const renderer = await loadBundle(gamePath, { useMainStore: { getState: () => nativeState }, bandForZoom: () => 'fixture' });
renderer.loadFunction('resolveMapContextMenuTarget');
renderer.loadFunction('getLayerPickingInfo');
renderer.loadValue('PICK_LAYER_IDS');
renderer.loadValue('PICK_RADIUS');
const classMethod = (name, method) => {
  const node = renderer.ast.body.find(node => node.type === 'ClassDeclaration' && node.id.name === name);
  const member = node?.body.body.find(node => propertyName(node) === method);
  assert.ok(member, `Missing ${name}.${method}`);
  return renderer.text(member);
};
const NativePathLayer = renderer.evaluate(`(() => {
  class NativeLayer { ${classMethod('Layer', 'getPickingInfo')} }
  class NativePathLayer extends NativeLayer { ${classMethod('PathLayer', 'getPickingInfo')} }
  return NativePathLayer;
})()`);
class Layer extends NativePathLayer {
  constructor(id, data) { super(); this.id = id; this.props = { id, data, visible: true, pickable: true }; }
  clone(overrides) { const next = new Layer(this.id, this.props.data); next.props = { ...this.props, ...overrides }; return next; }
}
const starts = [0], positions = [];
for (const path of [[[10, 10], [11, 11]], [[0.5, 0.5], [2.5, 0.5]], [[0.1, 0.2], [0.8, 0.2]]]) {
  for (const point of path) positions.push(...point);
  starts.push(positions.length / 2);
}
const source = { length: 3, startIndices: new Uint32Array(starts), attributes: { getPath: { size: 2, value: new Float64Array(positions) } } };
const nativeLayers = [new Layer('portolan-ribbons', source), new Layer('portolan-ribbons-under', source)];
const deck = { props: { layers: nativeLayers }, setProps(next) { this.props = { ...this.props, ...next }; } };
const map = { __deck: deck, getZoom: () => 12, getBounds: () => [0, 0, 3, 1], getStyle: () => ({ layers: [] }) };
const virtualization = { signature: 'shipped-context-menu', haloBounds: [[0, 0, 1, 1], [2, 0, 3, 1]] };
installMovementDeckVisibilityGuard(map, { map }, () => virtualization, () => 1);
const results = [];
for (const layer of deck.props.layers) {
  for (const index of [0, 1, 2]) {
    const object = { nativeMarker: 'preserved' };
    const picked = renderer.context.getLayerPickingInfo({ layer, info: { index, object, layer, picked: true }, mode: 'query' });
    assert.strictEqual(picked.object, object);
    assert.strictEqual(picked.sourceLayer, layer);
    const target = renderer.context.resolveMapContextMenuTarget({ pickObject: () => picked }, { x: 1, y: 1 }, 12);
    const expected = index < 2 ? 'split' : 'inside';
    assert.deepEqual(Array.from(target.routeIds), [expected]);
    results.push({ layer: layer.id, renderedIndex: index, nativeIndex: picked.index, route: expected });
  }
  for (const index of [-1, 99]) {
    const picked = renderer.context.getLayerPickingInfo({ layer, info: { index, layer }, mode: 'query' });
    assert.equal(renderer.context.resolveMapContextMenuTarget({ pickObject: () => picked }, { x: 1, y: 1 }, 12), null);
  }
}
deck.setProps({ layers: deck.props.layers });
assert.equal(renderer.context.getLayerPickingInfo({ layer: deck.props.layers[0], info: { index: 0 }, mode: 'query' }).index, 1);
assert.equal(nativeLayers[0].getPickingInfo({ info: { index: 0 } }).index, 0);
console.log(JSON.stringify({ indexSha256: native.hash, rendererSha256: renderer.hash,
  baselineChoice, native172Choice: ids(nativeQuery(native)), pickingResults: results,
  stubs: ['coordinate precision=6', 'renderer band selection=fixture', 'native store data', 'GPU pick hit'],
  executed: ['native Dijkstra and flip-aware search', 'native Layer/PathLayer picking methods', 'native getLayerPickingInfo pipeline', 'native resolveMapContextMenuTarget', 'mod binary clipping and picking remap'],
}, null, 2));
console.log('PASS: shipped crossover differential and context-menu picks retain native source identity');
