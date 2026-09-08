import test from 'node:test';
import assert from 'node:assert/strict';
import { LandSelection, LAND_SELECTION_LAYER, paintLandSelection } from '../src/runtime/ui/land-selection.js';

const square = (x, y, size) => ({ type: 'Polygon', coordinates: [[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]] });
function canvas() {
  const operations = [];
  const context = { operations, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clearRect() {},
    fill(rule) { operations.push(['fill', this.globalCompositeOperation, rule, this.globalAlpha]); },
    drawImage() { operations.push(['image', this.globalCompositeOperation]); } };
  return { width: 0, height: 0, getContext: () => context };
}

test('land is unioned, lake holes removed, and the complete selection is intersected with that mask', () => {
  const output = canvas(), mask = canvas();
  paintLandSelection(output, mask, { land: [{ geometry: square(1,1,8) }, { geometry: square(2,2,6) }],
    water: [{ geometry: square(4,4,2) }], active: square(0,0,10), hovered: null,
    project: coordinate => coordinate, width: 10, height: 10 });
  assert.deepEqual(mask.getContext().operations.map(op => op.slice(0,3)), [
    ['fill', 'source-over', 'evenodd'], ['fill', 'source-over', 'evenodd'], ['fill', 'destination-out', 'evenodd'],
  ]);
  assert.deepEqual(output.getContext().operations.at(-1), ['image', 'destination-in']);
});

test('mask is bounded, dormant between changes and during movement, refreshed for native tiles, and disposed', () => {
  const sources = new Map(), layers = new Map(), listeners = new Map(), canvases = [];
  let moving = false, queries = 0, plays = 0, pauses = 0;
  const map = { getZoom: () => 7, isMoving: () => moving, getCanvas: () => ({ width: 4000, height: 2000 }),
    getBounds: () => ({ getWest: () => 0, getEast: () => 10, getNorth: () => 10, getSouth: () => 0 }),
    querySourceFeatures() { queries++; return []; }, getLayer: id => layers.get(id), getSource: id => id === 'open-world-world-context-source' ? {} : sources.get(id),
    addSource(id) { sources.set(id, { setCoordinates() {}, play() { plays++; }, pause() { pauses++; } }); },
    addLayer(layer) { layers.set(layer.id, layer); }, removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id),
    setLayoutProperty(id, name, value) { layers.get(id)[name] = value; },
    on(name, fn) { listeners.set(name, fn); }, once(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const mask = new LandSelection(map, () => { const result = canvas(); canvases.push(result); return result; });
  const selection = { active: square(0,0,10), hovered: null };
  mask.update(selection);
  assert.equal(canvases[0].width, 1024); assert.equal(canvases[0].height, 512);
  listeners.get('render')();
  assert.equal(plays, 1); assert.equal(pauses, 1);
  mask.update(selection); assert.equal(queries, 2);
  moving = true; listeners.get('movestart')(); mask.update(selection);
  assert.equal(queries, 2); assert.equal(layers.get(LAND_SELECTION_LAYER).visibility, 'none');
  moving = false; listeners.get('moveend')(); assert.equal(queries, 4);
  listeners.get('sourcedata')({ sourceId: 'unrelated' }); listeners.get('idle')(); assert.equal(queries, 4);
  listeners.get('sourcedata')({ sourceId: 'open-world-world-context-source' }); listeners.get('idle')(); assert.equal(queries, 6);
  mask.dispose();
  assert.equal(sources.size, 0); assert.equal(layers.size, 0); assert.equal(listeners.size, 0);
  assert.ok(canvases.every(item => item.width === 1 && item.height === 1));
});

test('retired maps and late callbacks never query a removed style', () => {
  const listeners = new Map();
  const fail = () => { throw new TypeError("Cannot read properties of undefined (reading 'querySourceFeatures')"); };
  const map = { style: undefined, getZoom: () => 7, getLayer: fail, getSource: fail, querySourceFeatures: fail,
    getCanvas: fail, getBounds: fail, on: (name, fn) => listeners.set(name, fn), off: name => listeners.delete(name) };
  const mask = new LandSelection(map, canvas), settle = mask.settle, hide = mask.hide;
  assert.doesNotThrow(() => mask.update({ active: square(0,0,10) }));
  assert.doesNotThrow(() => hide());
  assert.doesNotThrow(() => mask.dispose());
  assert.doesNotThrow(() => settle());
  assert.equal(listeners.size, 0);
});
