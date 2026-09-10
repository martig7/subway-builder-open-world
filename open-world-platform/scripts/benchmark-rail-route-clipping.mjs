import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const overlayModuleUrl = process.env.RAIL_CLIP_OVERLAY_MODULE
  ? pathToFileURL(resolve(process.env.RAIL_CLIP_OVERLAY_MODULE)).href
  : new URL('../src/runtime/ui/geographic-context-overlay.js', import.meta.url).href;
const { registerGeographicContextOverlay } = await import(overlayModuleUrl);

const pathCount = Math.max(1, Number.parseInt(process.argv[2] ?? '19', 10));
const totalVertexCount = Math.max(pathCount * 2, Number.parseInt(process.argv[3] ?? '18557', 10));
const iterations = Math.max(1, Number.parseInt(process.argv[4] ?? '5', 10));
const basePathLength = Math.floor(totalVertexCount / pathCount);
const extraVertices = totalVertexCount % pathCount;
const pathLengths = Array.from(
  { length: pathCount },
  (_, index) => basePathLength + (index < extraVertices ? 1 : 0),
);

function layer(id, data, visible = true) {
  return {
    id,
    props: { id, data, visible },
    clone(overrides = {}) {
      return layer(
        overrides.id ?? id,
        overrides.data ?? this.props.data,
        overrides.visible ?? this.props.visible,
      );
    },
  };
}

function fixtureMap(initialLayers) {
  let zoom = 12;
  const listeners = new Map();
  const sources = new Map();
  const layers = new Map();
  const order = [];
  const deck = {
    props: { layers: initialLayers },
    setProps(next) { this.props = { ...this.props, ...next }; },
    redraw() {},
  };
  return {
    __deck: deck,
    listeners,
    isStyleLoaded: () => true,
    getBounds: () => [-1, -1, 12, 2],
    getZoom: () => zoom,
    setZoom(value) { zoom = value; },
    getSource: id => sources.get(id),
    addSource(id, definition) {
      sources.set(id, { ...definition, setData(data) { this.data = data; } });
    },
    removeSource: id => sources.delete(id),
    getLayer: id => layers.get(id),
    getStyle: () => ({ layers: order.map(id => layers.get(id)).filter(Boolean), sources: Object.fromEntries(sources) }),
    addLayer(definition, beforeId) {
      layers.set(definition.id, definition);
      const before = beforeId == null ? -1 : order.indexOf(beforeId);
      order.splice(before < 0 ? order.length : before, 0, definition.id);
    },
    removeLayer(id) {
      layers.delete(id);
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
    },
    moveLayer(id, beforeId) {
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
      const before = beforeId == null ? -1 : order.indexOf(beforeId);
      order.splice(before < 0 ? order.length : before, 0, id);
    },
    setLayerZoomRange() {},
    getContainer: () => ({ dataset: {} }),
    getCanvas: () => ({ style: {} }),
    on(event, layerOrCallback, callback) {
      listeners.set(typeof callback === 'function' ? `${event}:${layerOrCallback}` : event, callback ?? layerOrCallback);
    },
    off(event, layerOrCallback, callback) {
      const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
      if (listeners.get(key) === (callback ?? layerOrCallback)) listeners.delete(key);
    },
  };
}

function pathPoint(pathIndex, vertexIndex, pathLength) {
  const progress = vertexIndex / (pathLength - 1);
  return [
    -0.5 + progress * 12,
    0.1 + (pathIndex % 800) / 1000 + Math.sin(progress * Math.PI * 4 + pathIndex) * 0.02,
  ];
}

function makeBinary() {
  const vertexCount = totalVertexCount;
  const starts = new Uint32Array(pathCount + 1);
  const positions = new Float64Array(vertexCount * 2);
  const colors = new Uint8Array(vertexCount * 4);
  const offsets = new Float32Array(vertexCount * 2);
  let pathStart = 0;
  for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
    const pathLength = pathLengths[pathIndex];
    starts[pathIndex] = pathStart;
    for (let vertexIndex = 0; vertexIndex < pathLength; vertexIndex += 1) {
      const flatIndex = pathStart + vertexIndex;
      const [x, y] = pathPoint(pathIndex, vertexIndex, pathLength);
      positions[flatIndex * 2] = x;
      positions[flatIndex * 2 + 1] = y;
      colors.set([pathIndex % 255, vertexIndex % 255, 127, 255], flatIndex * 4);
      offsets[flatIndex * 2] = (pathIndex % 7) - 3;
    }
    pathStart += pathLength;
  }
  starts[pathCount] = vertexCount;
  return {
    length: pathCount,
    startIndices: starts,
    attributes: {
      getPath: { size: 2, value: positions },
      getColor: { size: 4, value: colors },
      getOffsetVecs: { size: 2, value: offsets },
    },
  };
}

function makeGeoJson() {
  return Array.from({ length: pathCount }, (_, pathIndex) => {
    const pathLength = pathLengths[pathIndex];
    const coordinates = Array.from(
      { length: pathLength },
      (_, vertexIndex) => pathPoint(pathIndex, vertexIndex, pathLength),
    );
    return {
      type: 'Feature',
      properties: {
        routeIds: [`route-${pathIndex}`],
        offset: coordinates.map((_, vertexIndex) => (vertexIndex % 7) - 3),
      },
      geometry: { type: 'LineString', coordinates },
    };
  });
}

function stageSnapshot() {
  const stage = globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4?.stages?.['deck.interlining.clip'];
  return { count: stage?.count ?? 0, totalMs: stage?.totalMs ?? 0 };
}

function measure(label, operation) {
  const before = stageSnapshot();
  const startedAt = performance.now();
  const output = operation();
  const wallMs = performance.now() - startedAt;
  const after = stageSnapshot();
  return {
    label,
    output,
    clips: after.count - before.count,
    clipMs: after.totalMs - before.totalMs,
    wallMs,
  };
}

function summarize(samples) {
  const ordered = values => [...values].sort((a, b) => a - b);
  const median = values => ordered(values)[Math.floor(values.length / 2)];
  return {
    scenario: samples[0].label,
    runs: samples.length,
    clips: samples.reduce((sum, sample) => sum + sample.clips, 0),
    medianClipMs: Number(median(samples.map(sample => sample.clipMs)).toFixed(3)),
    medianWallMs: Number(median(samples.map(sample => sample.wallMs)).toFixed(3)),
    maxClipMs: Number(Math.max(...samples.map(sample => sample.clipMs)).toFixed(3)),
  };
}

const catalog = {
  id: 'rail-route-clipping-benchmark',
  tiles: [
    { id: 'A', column: 0, row: 0, bounds: [0, 0, 1, 1] },
    { id: 'B', column: 10, row: 0, bounds: [10, 0, 11, 1] },
  ],
};

let activeTileId = 'A';
let interliningRevision = 1;
let runtimeListener = null;
const runtime = {
  getActiveTileId: () => activeTileId,
  getInterliningRevision: () => interliningRevision,
  subscribe(listener) {
    runtimeListener = listener;
    return () => { runtimeListener = null; };
  },
};

const initialBinary = makeBinary();
const map = fixtureMap([layer('portolan-ribbons', initialBinary)]);
const controller = registerGeographicContextOverlay({
  runtime,
  tileCatalog: catalog,
  renderDistance: 1,
  renderDistanceStorage: null,
});

const originalInfo = console.info;
console.info = () => {};
globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
let report = null;

try {
  const initial = measure('portolan initial', () => controller.attachMap(map));
  assert.equal(initial.clips, 1);

  const binaryHit = measure('portolan same-source hit', () => {
    map.__deck.setProps({ layers: [layer('portolan-ribbons', initialBinary)] });
  });
  assert.equal(binaryHit.clips, 0);

  const binaryZoomCrossings = [];
  let previousRenderedBinary = map.__deck.props.layers[0].props.data;
  let binaryBufferReplacements = 0;
  for (const zoom of [9, 11, 9, 11]) {
    binaryZoomCrossings.push(measure('portolan fixed-mask overview zoom crossing', () => {
      map.setZoom(zoom);
      map.__deck.setProps({ layers: [layer('portolan-ribbons', initialBinary)] });
    }));
    const renderedBinary = map.__deck.props.layers[0].props.data;
    if (renderedBinary !== previousRenderedBinary) binaryBufferReplacements += 1;
    previousRenderedBinary = renderedBinary;
  }

  const binaryReplacements = [];
  for (let index = 0; index < iterations; index += 1) {
    const replacement = makeBinary();
    binaryReplacements.push(measure('portolan replacement, stable revision', () => {
      map.__deck.setProps({ layers: [layer('portolan-ribbons', replacement)] });
    }));
  }
  assert.ok(binaryReplacements.every(sample => sample.clips === 1));

  const binaryHiddenReveal = measure('portolan known-revision hidden + reveal', () => {
    const source = map.__deck.__openWorldMovementDeckVisibilityGuard.nativeLayers[0].props.data;
    map.__deck.setProps({ layers: [layer('portolan-ribbons', source, false)] });
    map.__deck.setProps({ layers: [layer('portolan-ribbons', source, true)] });
  });

  const retainedBinary = map.__deck.__openWorldMovementDeckVisibilityGuard.nativeLayers[0].props.data;
  const binaryMaskChange = measure('portolan active-tile mask change', () => {
    activeTileId = 'B';
    runtimeListener({ type: 'projection-changed', tileId: 'B' }, { activeTileId: 'B' });
  });
  assert.equal(binaryMaskChange.clips, 1);
  assert.strictEqual(map.__deck.__openWorldMovementDeckVisibilityGuard.nativeLayers[0].props.data, retainedBinary);

  let geoJson = makeGeoJson();
  const geoInitial = measure('geojson initial', () => {
    map.__deck.setProps({ layers: [layer('interlined-routes', geoJson)] });
  });
  assert.equal(geoInitial.clips, 1);

  const geoStableReplacement = makeGeoJson();
  const geoRevisionHit = measure('geojson replacement, stable revision', () => {
    map.__deck.setProps({ layers: [layer('interlined-routes', geoStableReplacement)] });
  });
  assert.equal(geoRevisionHit.clips, 0);
  geoJson = geoStableReplacement;

  const geoRevisionMisses = [];
  for (let index = 0; index < iterations; index += 1) {
    interliningRevision += 1;
    geoJson = makeGeoJson();
    geoRevisionMisses.push(measure('geojson replacement + revision change', () => {
      map.__deck.setProps({ layers: [layer('interlined-routes', geoJson)] });
    }));
  }
  assert.ok(geoRevisionMisses.every(sample => sample.clips === 1));

  const geoHiddenReveal = measure('geojson known-revision hidden + reveal', () => {
    map.__deck.setProps({ layers: [layer('interlined-routes', geoJson, false)] });
    map.__deck.setProps({ layers: [layer('interlined-routes', geoJson, true)] });
  });

  const geoMaskChange = measure('geojson active-tile mask change', () => {
    activeTileId = 'A';
    runtimeListener({ type: 'projection-changed', tileId: 'A' }, { activeTileId: 'A' });
  });
  assert.equal(geoMaskChange.clips, 1);

  const rows = [
    summarize([initial]),
    summarize([binaryHit]),
    { ...summarize(binaryZoomCrossings), binaryBufferReplacements },
    summarize(binaryReplacements),
    summarize([binaryHiddenReveal]),
    summarize([binaryMaskChange]),
    summarize([geoInitial]),
    summarize([geoRevisionHit]),
    summarize(geoRevisionMisses),
    summarize([geoHiddenReveal]),
    summarize([geoMaskChange]),
  ];
  report = {
    fixture: { pathCount, totalVertices: totalVertexCount, attributes: 3, iterations },
    rows,
  };
} finally {
  globalThis.__enableOpenWorldMapMovePerfDebug(false);
  controller.dispose();
  console.info = originalInfo;
}

const reportJson = JSON.stringify(report, null, 2);
if (process.env.RAIL_CLIP_REPORT) writeFileSync(resolve(process.env.RAIL_CLIP_REPORT), `${reportJson}\n`);
console.log(reportJson);
