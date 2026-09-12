import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossDemandModel } from '../src/runtime/cross-demand-model.js';
import { CrossDemandOverlayController } from '../src/runtime/ui/cross-demand-viewer.js';
import { demandPanelContent } from '../src/runtime/ui/cross-demand-presentation.js';
import { routeDesignBadge } from '../src/runtime/ui/route-design-badge.js';

const raw = { schemaVersion: 1, gateways: ['g'], points: [
  ['home', 136.7, 35.1, 'a', 200, 0], ['work', 139.4, 35.3, 'b', 0, 200],
], pops: [['cross-pop', 200, 0, 1, 0, '07:30', '17:30', 13942, 320004]] };
const choices = { 'cross-pop': { transit: 40, driving: 160, walking: 0 } };
function setup() {
  const sources = new Map(), layers = new Map(), handlers = new Map(), writes = [];
  let loaded = true, resolveRoute, inspections = 0, requests = 0;
  const map = { isStyleLoaded: () => loaded, getSource: id => sources.get(id), getLayer: id => layers.get(id),
    addSource(id, source) { sources.set(id, { ...source, setData(data) { this.data = data; writes.push(id); } }); },
    addLayer(layer) { layers.set(layer.id, layer); }, on(type, ...args) { handlers.set(type, args.at(-1)); }, off(type) { handlers.delete(type); },
    getCanvas: () => ({ style: {} }), setLayoutProperty(id, prop, value) { layers.get(id).layout[prop] = value; },
    setPaintProperty(id, prop, value) { layers.get(id).paint[prop] = value; }, fitBounds(bounds, options) { this.fit = { bounds, options }; }, jumpTo(value) { this.camera = value; }, getZoom: () => 8,
  };
  const controller = new CrossDemandOverlayController({ api: {}, tileCatalog: { tiles: [{ id: 'a', name: 'Aichi' }, { id: 'b', name: 'Kanagawa' }] },
    runtime: { getActiveTileId: () => 'b', view: () => ({ crossPopModeChoices: choices }), inspectCrossTileModeChoice() { inspections++; return { transitPath: { available: false } }; } },
    tilePackages: { loadCrossDemand: async () => raw }, routePaths: { resolve() { requests++; return new Promise(resolve => { resolveRoute = resolve; }); } },
  });
  controller.attachMap(map);
  return { controller, map, sources, layers, writes, handlers, loaded: value => { loaded = value; },
    finish: () => resolveRoute({ source: 'stored-osrm', coordinates: [[136.7,35.1],[138,35],[139.4,35.3]] }), counts: () => ({ inspections, requests }) };
}

test('summaries conserve cached mode counts; map filters use assigned modes', () => {
  const model = new CrossDemandModel(raw, {}, choices);
  const summary = model.summary('residents');
  assert.equal(summary.population, 200);
  assert.equal(summary.modeChoice.transit, 40);
  assert.equal(summary.modeChoice.driving, 160);
  assert.equal(summary, model.summary('residents'));
  assert.equal(model.pointFeatures('residents', null, 'transit').features[0].properties.population, 40);
  assert.equal(model.pointFeatures('residents', null, 'walking').features.length, 0);
  assert.equal(model.popDetails(0).drivingDistance, 320004);
  const withLocations = new CrossDemandModel({ ...raw, points: [...raw.points,
    ...Array.from({ length: 8 }, (_, i) => [`location-${i}`, 139, 35, 'b', 0, 0])] }, {}, choices);
  for (let i = 0; i < 8; i++) withLocations.summary('residents', `location-${i}`);
  assert.equal(withLocations.summaryCache.size, 4);
});

test('one-way trips have their own origin and destination dots without inflating resident or worker stock', () => {
  const typed = { ...raw, pops: [...raw.pops,
    ['one-way', 25, 0, 1, 0, '12:00', '', 13942, 320004, 'oneWay']] };
  const model = new CrossDemandModel(typed, {}, choices);
  assert.equal(model.stats.population, 200);
  assert.equal(model.stats.oneWayMovements, 25);
  assert.equal(model.pointFeatures('residents').features[0].properties.population, 200);
  assert.equal(model.pointFeatures('workers').features[0].properties.population, 200);
  assert.equal(model.pointFeatures('outboundMovements').features[0].properties.population, 25);
  assert.equal(model.pointFeatures('inboundMovements').features[0].properties.population, 25);
  assert.equal(model.pointDetails('home', 'outboundMovements').popCount, 1);
  assert.equal(model.pointDetails('work', 'inboundMovements').popCount, 1);
  assert.equal(model.summary('outboundMovements').population, 25);
  assert.equal(model.connections('home', 'outboundMovements').features[0].properties.mass, 25);
  assert.equal(model.popDetails(1).tripType, 'oneWay');
});

test('route completion and fading do not rebuild demand dots or repeat trip inspection', async () => {
  const s = setup(); await s.controller.open(); s.controller.selectPoint('home'); s.controller.selectPop(0);
  s.controller.popDetails(); s.controller.popDetails();
  const writes = s.writes.length;
  s.finish(); await new Promise(resolve => setImmediate(resolve));
  s.controller.popDetails();
  assert.deepEqual(s.writes.slice(writes), ['kc-cross-demand-details-source']);
  const done = s.writes.length;
  s.controller.setFaded(true);
  assert.equal(s.writes.length, done);
  assert.deepEqual(s.counts(), { inspections: 1, requests: 1 });
  s.controller.fitRoute(); assert.deepEqual(s.map.fit.bounds, [[136.7,35],[139.4,35.3]]);
  s.controller.fitRoute({ left: 800 }); assert.equal(s.map.fit.options.padding.right, 440);
  s.controller.focusEndpoint('work'); assert.deepEqual(s.map.camera.center, [139.4,35.3]);
});

test('fade applies the native deck gamma-adjusted factor to both fill and outline without rebuilding dots', async () => {
  const s = setup(); await s.controller.open();
  const paint = s.layers.get('kc-cross-demand-points').paint;
  const fill = paint['circle-opacity'], stroke = paint['circle-stroke-opacity'], writes = s.writes.length;
  s.controller.setFaded(true);
  // Native demand-points opacity is 0.33; deck's shader uniform uses pow(opacity, 1 / 2.2).
  assert.ok(Math.abs(paint['circle-opacity'] / fill - 0.33 ** (1 / 2.2)) < 1e-10);
  assert.ok(Math.abs(paint['circle-stroke-opacity'] / stroke - 0.33 ** (1 / 2.2)) < 1e-10);
  s.controller.setFaded(false);
  assert.equal(paint['circle-opacity'], fill); assert.equal(paint['circle-stroke-opacity'], stroke);
  assert.equal(s.writes.length, writes);
});

test('changing Residents/Workers invalidates an in-flight selection; closing while style loads is applied at idle', async () => {
  const s = setup(); await s.controller.open(); s.controller.selectPoint('home'); s.controller.selectPop(0);
  s.controller.setViewMode('workers'); s.finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.controller.selectedDrivingPath, null); assert.equal(s.controller.routeStatus, 'idle');
  s.loaded(false); s.controller.close(); s.loaded(true); s.handlers.get('idle')();
  assert.equal(s.layers.get('kc-cross-demand-pop-line').layout.visibility, 'none');
  assert.deepEqual(s.sources.get('kc-cross-demand-details-source').data.features, []);
  s.controller.dispose(); assert.equal(s.handlers.has('idle'), false);
});

test('selected routes retain both endpoints outside the render halo and tiny dots have a bounded click tolerance', async () => {
  const s = setup(); await s.controller.open();
  let query;
  s.map.queryRenderedFeatures = bounds => { query = bounds; return [{ properties: { id: 'home' } }]; };
  s.controller.handlePointClick({ point: { x: 100, y: 200 } });
  assert.equal(s.controller.selectedPointId, 'home'); assert.deepEqual(query, [[96,196],[104,204]]);
  s.controller.rendererVirtualization = { getRendererVirtualization: () => ({ presentation: () => null }) };
  s.controller.selectPop(0); s.finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.sources.get('kc-cross-demand-details-source').data.features.length, 3);
  assert.equal(s.layers.get('kc-cross-demand-pop-line').minzoom, 0);
});

test('native-style trip view exposes real travel facts and Home/Work/fit controls without internal identifiers', async () => {
  const s = setup(); await s.controller.open(); s.controller.selectPop(0);
  const h = (tag, props, ...children) => ({ tag, props, children: children.flat() });
  const tree = demandPanelContent({ h, controller: s.controller, snapshot: s.controller.snapshot(), pop: s.controller.popDetails() });
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join(' ') ?? '';
  const visible = text(tree);
  assert.match(visible, /320.0 km/); assert.match(visible, /Aichi/); assert.match(visible, /Kanagawa/);
  assert.match(visible, /Show whole route/); assert.match(visible, /Home point/); assert.match(visible, /07:30/);
  assert.doesNotMatch(visible, /cross-pop|stored-osrm|Income Distribution/);
  s.finish(); await new Promise(resolve => setImmediate(resolve));
});

test('trip route badges read current native designs, omit heavy arrays and retain text when unavailable', async () => {
  const s = setup(); await s.controller.open();
  const native = { id: 'route-a', bullet: 'T01', fullName: 'Tokaido Local', color: '#e87516', textColor: '#fff',
    shape: 'diamond', bordered: true, font: 'mono', stNodes: [{}], stCombos: [{}] };
  s.controller.api.gameState = { getRoutes: () => [native] };
  const route = { routeId: 'route-a', name: 'Old name' };
  const design = s.controller.routeDesign(route);
  assert.equal(design.name, 'Tokaido Local'); assert.equal(design.stNodes, undefined); assert.equal(design.stCombos, undefined);
  native.color = '#112233'; assert.equal(s.controller.routeDesign(route).color, '#112233');
  const h = (tag, props, ...children) => ({ tag, props, children: children.flat() });
  const badge = routeDesignBadge(h, design), outer = badge.children[0], inner = outer.children[0];
  assert.equal(badge.props['data-cross-route-badge'], 'route-a');
  assert.equal(outer.props.style.backgroundColor, '#e87516'); assert.equal(outer.props.style.fontFamily, 'var(--font-mono)');
  assert.match(outer.props.style.clipPath, /polygon/); assert.equal(inner.props.style.backgroundColor, '#000000');
  assert.match(inner.props.style.clipPath, /calc/);
  for (const shape of ['circle', 'rounded-square', 'square', 'triangle']) {
    const rendered = routeDesignBadge(h, { ...design, shape });
    assert.equal(rendered.children[1].children[0], 'Tokaido Local');
    if (shape === 'triangle') assert.match(rendered.children[0].props.style.clipPath, /polygon/);
  }
  const missing = { routeId: 'off-tile', name: 'Regional Express' };
  assert.equal(s.controller.routeDesign(missing), missing);
  assert.deepEqual(routeDesignBadge(h, missing).children, ['Regional Express']);
  const pop = { ...s.controller.model.popDetails(0), transitPath: { available: true, totalClockSeconds: 100,
    continuousLeg: { available: true, originStationName: 'Home', destinationStationName: 'Work', routes: [route] } } };
  const tree = demandPanelContent({ h, controller: s.controller, snapshot: s.controller.snapshot(), pop });
  assert.match(JSON.stringify(tree), /data-cross-route-badge/);
  assert.deepEqual(s.counts(), { inspections: 0, requests: 0 });
});
