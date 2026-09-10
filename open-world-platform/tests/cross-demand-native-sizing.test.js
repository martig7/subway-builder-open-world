import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossDemandOverlayController } from '../src/runtime/ui/cross-demand-viewer.js';
import { nativeDemandRadius, readNativeDemandPresentation } from '../src/runtime/ui/native-demand-presentation.js';
import { appendCrossDemandDeckLayer, CROSS_DEMAND_DECK_LAYER } from '../src/runtime/ui/native-demand-deck.js';

const radius = mass => Math.sqrt(mass / Math.PI) * 6.5;
function setup() {
  const layers = new Map(), sources = new Map(), handlers = new Map();
  let scale = 1, latitude = 35, zoom = 13, clones = 0;
  const ui = { userActionObj: { value: 'none' }, demandStatsView: 'homes' };
  const current = { memoizedProps: { value: ui } };
  const root = { __reactContainer$test: { stateNode: { current } } };
  const document = { getElementById: () => root };
  const canvas = { style: { cursor: 'crosshair' }, ownerDocument: document };
  class NativeMapboxLayer {
    constructor(props) { this.props = props; this.id = props.id; this.type = 'custom'; }
    onAdd(map) { this.map = map; map.__deck.userData.mapboxLayers.add(this); }
    onRemove() { this.map.__deck.userData.mapboxLayers.delete(this); }
    render() {
      return this.map.__deck.props.layers.flat(Infinity)
        .filter(layer => layer.id === this.id && layer.props.visible).flatMap(layer => layer.props.data);
    }
  }
  const native = { id: 'demand-points', props: {
    pointRadiusScale: 1, pointRadiusUnits: 'meters', stroked: true,
    updateTriggers: { data: [true, null, 0, 1] }, data: [],
  }, clone(overrides) { clones++; return { id: overrides.id, props: { ...this.props, ...overrides } }; } };
  const map = {
    isStyleLoaded: () => true, getSource: id => sources.get(id), getLayer: id => layers.get(id),
    addSource(id, source) { sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    addLayer(layer) { layers.set(layer.id, layer); layer.onAdd?.(map); },
    removeLayer(id) { layers.get(id)?.onRemove?.(); layers.delete(id); },
    setPaintProperty(id, key, value) { layers.get(id).paint[key] = value; },
    setLayoutProperty(id, key, value) { layers.get(id).layout[key] = value; },
    getCenter: () => ({ lat: latitude }), getZoom: () => zoom, getCanvas: () => canvas,
    on(type, ...args) { handlers.set(type, args.at(-1)); }, off(type) { handlers.delete(type); },
  };
  map.__deck = {
    userData: { isExternal: true, mapboxLayers: new Set() },
    props: { layers: [native] },
    __openWorldMovementDeckVisibilityGuard: { nativeLayers: [native] },
    setProps(props) {
      this.props = { ...this.props, ...props };
      if (props.layers) this.props.layers = appendCrossDemandDeckLayer(map, props.layers, props.layers);
    },
  };
  map.addLayer(new NativeMapboxLayer({ id: 'demand-points', deck: map.__deck }));
  const api = { actions: { getDemandBubbleScale: () => scale },
    gameState: { getDemandData: () => ({ points: new Map([['native', { residents: 500, jobs: 500 }]]) }) } };
  const controller = new CrossDemandOverlayController({ api,
    runtime: { getActiveTileId: () => 'a', view: () => ({}) },
    tilePackages: { loadCrossDemand: async () => ({ schemaVersion: 1,
      points: [['home', 139, 35, 'a', 500, 0], ['work', 140, 36, 'b', 0, 500]],
      pops: [['p', 500, 0, 1, 0]],
    }) },
  });
  controller.attachMap(map);
  return { controller, map, native, layers, sources, handlers, ui, canvas, current,
    change(value, lat = latitude) { scale = value; latitude = lat; },
    camera(z, lat) { zoom = z; latitude = lat; }, clones: () => clones,
    submit() { map.__deck.setProps({ layers: [native] }); },
    layer() { return map.__deck.props.layers.flat(Infinity).find(layer => layer.id === CROSS_DEMAND_DECK_LAYER); },
  };
}

test('cross demand participates in the native map screen pass, not only deck picking', async () => {
  const s = setup(); await s.controller.open();
  const drawLayer = s.map.getLayer(CROSS_DEMAND_DECK_LAYER);
  assert.equal(drawLayer?.type, 'custom', 'demand needs a native MapboxLayer screen draw registration');
  assert.equal(drawLayer.render().length, 1, 'the screen pass must draw the resident dot');
  s.submit(); assert.equal(s.map.getLayer(CROSS_DEMAND_DECK_LAYER), drawLayer);
  s.controller.close(); assert.equal(s.map.getLayer(CROSS_DEMAND_DECK_LAYER), undefined);
  await s.controller.open();
  const replacement = s.map.getLayer(CROSS_DEMAND_DECK_LAYER);
  s.map.removeLayer(CROSS_DEMAND_DECK_LAYER); // Native style reload removed custom layers.
  s.handlers.get('idle')();
  assert.ok(s.map.getLayer(CROSS_DEMAND_DECK_LAYER));
  assert.notEqual(s.map.getLayer(CROSS_DEMAND_DECK_LAYER), replacement);
  s.controller.dispose(); assert.equal(s.map.getLayer(CROSS_DEMAND_DECK_LAYER), undefined);
});

test('cross dots use the native renderer, metre radius, centered outline and current population scale', async () => {
  const s = setup(); await s.controller.open();
  for (const [scale, zoomScale] of [[1, 1], [5, 0.5], [0.3, 2]]) {
    s.change(scale); s.native.props.pointRadiusScale = zoomScale; s.submit();
    const { props } = s.layer(), feature = props.data[0];
    assert.equal(props.pointRadiusUnits, 'meters');
    assert.equal(props.getPointRadius(feature), radius(500) * scale);
    assert.equal(props.pointRadiusScale, zoomScale);
    assert.equal(props.getLineWidth(feature), 4);
    assert.equal(props.stroked, true);
    assert.equal(s.layers.get('kc-cross-demand-points').layout.visibility, 'none');
  }
});

test('camera-only zoom frames do not rewrite paint or recreate demand layers or buffers', async () => {
  const s = setup(); await s.controller.open();
  const originalLayer = s.layer(), clones = s.clones(), source = s.sources.get('kc-cross-demand-points-source').data;
  let paintWrites = 0;
  s.map.setPaintProperty = () => paintWrites++;
  assert.equal(s.handlers.has('render'), false, 'no per-frame sizing observer');
  for (let frame = 0; frame < 60; frame++) {
    s.camera(10 + frame / 12, 35 + frame / 1000);
    // The native deck guard may receive layers during camera updates. Identical
    // demand inputs must still reuse the exact instance and its attribute data.
    s.submit();
    assert.equal(s.layer(), originalLayer);
  }
  assert.equal(paintWrites, 0);
  assert.equal(s.clones(), clones);
  assert.equal(s.sources.get('kc-cross-demand-points-source').data, source);
});

test('calibrates from current native demand and rejects the selection-specific radius curve', async () => {
  const s = setup();
  s.native.props.data = [{ properties: { id: 'native', size: radius(500) * 5, selected: false } }];
  await s.controller.open();
  assert.equal(s.layer().props.getPointRadius(s.layer().props.data[0]), radius(500) * 5);
  const data = s.layer().props.data;
  s.change(0.5);
  s.native.props.updateTriggers.data = [true, 'native', 0, 0.5];
  s.native.props.data = [{ properties: { id: 'native', size: 800, selected: false } }];
  s.submit();
  assert.equal(s.layer().props.data, data);
  assert.equal(s.layer().props.getPointRadius(data[0]), radius(500) * 0.5);
});

test('worker, logarithmic and selected-location radii use native curves; fade is handled by deck', async () => {
  const s = setup(); await s.controller.open(); s.controller.setViewMode('workers');
  assert.equal(s.layer().props.getPointRadius(s.layer().props.data[0]), Math.sqrt(500 / Math.PI) * 2.5);
  for (const population of [1, 500, 10000, 40000]) {
    assert.equal(nativeDemandRadius(population, 'residents', true), 4 + Math.min(Math.log(population) / Math.log(10000), 1) * 36);
    assert.equal(nativeDemandRadius(population, 'workers', true), 3 + Math.min(Math.log(population) / Math.log(10000), 1) * 27);
  }
  assert.equal(readNativeDemandPresentation({}, s.map, { getItem: () => '{"DEMAND_DOT_SCALING":true}' }).logarithmic, true);
  s.controller.selectPoint('work'); s.controller.setFaded(true);
  assert.equal(s.layer().props.getPointRadius(s.layer().props.data[0]), 80);
  assert.equal(s.layer().props.getLineWidth(s.layer().props.data[0]), 20);
  assert.equal(s.layer().props.opacity, 0.33);
});

test('native picking preserves construction-tool guards and a bounded small-dot tolerance', async () => {
  const s = setup(); await s.controller.open();
  const feature = s.layer().props.data[0];
  s.ui.userActionObj = { value: 'draw-parallel-tracks', ignoreClick: true };
  s.layer().props.onClick({ object: feature });
  s.layer().props.onHover({ object: feature });
  assert.equal(s.controller.selectedPointId, null);
  assert.equal(s.canvas.style.cursor, 'crosshair');
  s.current.memoizedProps = { value: { ...s.ui, userActionObj: { value: 'none' } } };
  let query;
  s.map.__deck.pickMultipleObjects = options => { query = options; return [{ object: feature }]; };
  s.controller.handlePointClick({ point: { x: 100, y: 200 } });
  assert.equal(s.controller.selectedPointId, 'home');
  assert.deepEqual(query, { x: 100, y: 200, radius: 4, depth: 16, layerIds: [CROSS_DEMAND_DECK_LAYER] });
  s.controller.dispose();
  assert.equal(s.layer(), undefined);
});

test('close, reopen, native layer disappearance and disposal retire cached deck instances', async () => {
  const s = setup(); await s.controller.open(); const first = s.layer();
  s.controller.close(); assert.equal(s.layer(), undefined);
  await s.controller.open(); assert.notEqual(s.layer(), first);
  const second = s.layer();
  s.map.__deck.setProps({ layers: [] }); assert.equal(s.layer(), undefined);
  s.submit(); assert.notEqual(s.layer(), second, 'never reinsert a finalized native layer');
  s.controller.dispose(); assert.equal(s.layer(), undefined);
});
