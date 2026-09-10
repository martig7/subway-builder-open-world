import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installMovementDeckVisibilityGuard,
} from '../src/runtime/ui/geographic-context-overlay.js';

class Layer {
  constructor(id, data, visible = true) {
    this.id = id;
    this.props = { id, data, visible };
  }

  clone(overrides = {}) {
    return new Layer(
      overrides.id ?? this.id,
      overrides.data ?? this.props.data,
      overrides.visible ?? this.props.visible,
    );
  }
}

function binaryPaths() {
  return {
    length: 1,
    startIndices: new Uint32Array([0, 5]),
    attributes: {
      getPath: {
        size: 2,
        value: new Float64Array([
          -76, 40.5,
          -75, 40.5,
          -74, 40.5,
          -73, 40.5,
          -72, 40.5,
        ]),
      },
      getOffsetVecs: {
        size: 2,
        value: new Float32Array([0, 0, 1, 0, 2, 0, 3, 0, 4, 0]),
      },
      getColor: {
        size: 4,
        value: new Uint8Array([
          1, 0, 0, 255,
          2, 0, 0, 255,
          3, 0, 0, 255,
          4, 0, 0, 255,
          5, 0, 0, 255,
        ]),
      },
    },
  };
}

function binaryFromPaths(paths, { arrayStarts = false, arrayColor = false } = {}) {
  const starts = [0];
  const positions = [];
  const colors = [];
  const offsets = [];
  for (const path of paths) {
    for (const [index, point] of path.entries()) {
      positions.push(...point);
      colors.push(index + 1, 0, 0, 255);
      offsets.push(index, 0);
    }
    starts.push(starts.at(-1) + path.length);
  }
  return {
    length: paths.length,
    startIndices: arrayStarts ? starts : new Uint32Array(starts),
    attributes: {
      getPath: { size: 2, value: new Float64Array(positions) },
      getColor: { size: 4, value: arrayColor ? colors : new Uint8Array(colors) },
      getOffsetVecs: { size: 2, value: new Float32Array(offsets) },
    },
  };
}

function fixture({ zoom = 11, revision = 7 } = {}) {
  let currentZoom = zoom;
  let currentRevision = revision;
  const source = binaryPaths();
  const deck = {
    props: { layers: [new Layer('portolan-ribbons', source)] },
    setProps(next) {
      this.props = { ...this.props, ...next };
      return this;
    },
  };
  const map = {
    __deck: deck,
    getBounds: () => [-76, 40, -72, 41],
    getZoom: () => currentZoom,
    getStyle: () => ({ layers: [] }),
  };
  const virtualization = {
    signature: 'A|1|circle',
    activeTileId: 'A',
    haloTileIds: ['A'],
    haloBounds: [[-75.5, 40, -73.5, 41]],
    renderInputs({ features }) { return { features }; },
  };
  installMovementDeckVisibilityGuard(
    map,
    { map },
    () => virtualization,
    () => currentRevision,
  );
  return {
    deck,
    source,
    virtualization,
    setRevision(value) { currentRevision = value; },
    setZoom(value) { currentZoom = value; },
  };
}

function clipCount() {
  return globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4
    ?.stages?.['deck.interlining.clip']?.count ?? 0;
}

test('Portolan binary clipping survives overview zoom crossings for a fixed render mask', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ zoom: 11 });
    const firstData = f.deck.props.layers[0].props.data;
    assert.equal(clipCount(), 1);

    for (const zoom of [9, 11, 9, 11]) {
      f.setZoom(zoom);
      f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source)] });
      assert.strictEqual(
        f.deck.props.layers[0].props.data,
        firstData,
        `zoom ${zoom} must retain the clipped binary buffers`,
      );
    }
    assert.equal(clipCount(), 1, 'overview visibility does not change Portolan clipping membership');
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});

test('fresh wholly contained Portolan source preserves its original typed buffers', () => {
  const f = fixture();
  const source = binaryFromPaths([
    [[-75.4, 40.2], [-74.5, 40.5], [-73.6, 40.8]],
    [[-75.3, 40.7], [-74.4, 40.6], [-73.7, 40.3]],
  ]);
  const starts = source.startIndices;
  const path = source.attributes.getPath.value;
  const color = source.attributes.getColor.value;
  const offsets = source.attributes.getOffsetVecs.value;

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  const rendered = f.deck.props.layers[0].props.data;
  assert.strictEqual(rendered, source, 'a contained cache miss must not clone the binary container');
  assert.strictEqual(rendered.startIndices, starts);
  assert.strictEqual(rendered.attributes.getPath.value, path);
  assert.strictEqual(rendered.attributes.getColor.value, color);
  assert.strictEqual(rendered.attributes.getOffsetVecs.value, offsets);
});

test('contained same-source mutation with a revision bump produces fresh updated buffers', () => {
  const f = fixture({ revision: 7 });
  const source = binaryFromPaths([[[-75.4, 40.2], [-74.5, 40.5], [-73.6, 40.8]]]);
  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });
  const firstRendered = f.deck.props.layers[0].props.data;
  const firstPath = firstRendered.attributes.getPath.value;
  const firstColor = firstRendered.attributes.getColor.value;
  const firstOffsets = firstRendered.attributes.getOffsetVecs.value;

  source.attributes.getPath.value[2] = -74.25;
  source.attributes.getColor.value.set([99, 88, 77, 255], 4);
  source.attributes.getOffsetVecs.value.set([20, 10], 2);
  f.setRevision(8);
  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  const nextRendered = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(nextRendered.attributes.getPath.value, firstPath);
  assert.notStrictEqual(nextRendered.attributes.getColor.value, firstColor);
  assert.notStrictEqual(nextRendered.attributes.getOffsetVecs.value, firstOffsets);
  assert.equal(nextRendered.attributes.getPath.value[2], -74.25);
  assert.deepEqual([...nextRendered.attributes.getColor.value.slice(4, 8)], [99, 88, 77, 255]);
  assert.deepEqual([...nextRendered.attributes.getOffsetVecs.value.slice(2, 4)], [20, 10]);
});

test('contained Portolan source without a revision retains the defensive copy fallback', () => {
  const f = fixture({ revision: null });
  const source = binaryFromPaths([[[-75.4, 40.2], [-74.5, 40.5], [-73.6, 40.8]]]);

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  const rendered = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(rendered, source);
  assert.notStrictEqual(rendered.startIndices, source.startIndices);
  assert.notStrictEqual(rendered.attributes.getPath.value, source.attributes.getPath.value);
  assert.notStrictEqual(rendered.attributes.getColor.value, source.attributes.getColor.value);
  assert.notStrictEqual(rendered.attributes.getOffsetVecs.value, source.attributes.getOffsetVecs.value);
});

test('Portolan containment honors a circular region rather than only its bounding box', () => {
  const f = fixture();
  const circularBounds = Object.assign([-1, -1, 1, 1], {
    region: { shape: 'circle', center: [0, 0], scale: [1, 1], distance: 1 },
  });
  f.virtualization.signature = 'circle-region';
  f.virtualization.haloBounds = [circularBounds];
  const source = binaryFromPaths([[[0.8, 0.8], [0.95, 0.95]]]);

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  const rendered = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(rendered, source);
  assert.equal(rendered.length, 0, 'coordinates outside the circle must still be clipped');
});

test('Portolan containment accepts a path whose vertices fit one circle when its bounding-box corners do not', () => {
  const f = fixture();
  const circularBounds = Object.assign([-1, -1, 1, 1], {
    region: { shape: 'circle', center: [0, 0], scale: [1, 1], distance: 1 },
  });
  f.virtualization.signature = 'circle-contained-path';
  f.virtualization.haloBounds = [circularBounds];
  const source = binaryFromPaths([[[-0.9, 0], [0, 0.9], [0.9, 0], [0, -0.9]]]);

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  assert.strictEqual(
    f.deck.props.layers[0].props.data,
    source,
    'a circle is convex, so segments between contained vertices need no clipping',
  );
});

test('Portolan containment does not bridge the gap in a disjoint halo union', () => {
  const f = fixture();
  f.virtualization.signature = 'disjoint-region';
  f.virtualization.haloBounds = [[0, 0, 1, 1], [2, 0, 3, 1]];
  const source = binaryFromPaths([[[0.5, 0.5], [2.5, 0.5]]]);

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });

  const rendered = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(rendered, source);
  assert.equal(rendered.length, 2, 'each intersected halo must retain its separate clipped piece');
  assert.deepEqual([...rendered.startIndices], [0, 2, 4]);
});

test('noncanonical Portolan geometry and attributes retain the clipping fallback', () => {
  const cases = [
    ['array start indices', binaryFromPaths([[[-75.4, 40.5], [-73.6, 40.5]]], { arrayStarts: true })],
    ['array attribute', binaryFromPaths([[[-75.4, 40.5], [-73.6, 40.5]]], { arrayColor: true })],
    ['duplicate adjacent coordinate', binaryFromPaths([[[-75.4, 40.5], [-75.4, 40.5], [-73.6, 40.5]]])],
    ['non-finite coordinate', binaryFromPaths([[[-75.4, 40.5], [Number.NaN, 40.5], [-73.6, 40.5]]])],
  ];
  for (const [label, source] of cases) {
    const f = fixture();
    f.deck.setProps({ layers: [new Layer('portolan-ribbons', source)] });
    assert.notStrictEqual(f.deck.props.layers[0].props.data, source, label);
  }
});

test('Portolan binary clipping rebuilds exact endpoints when the clipping region changes', () => {
  const f = fixture();
  const firstData = f.deck.props.layers[0].props.data;
  f.virtualization.signature = 'B|1|circle';
  f.virtualization.activeTileId = 'B';
  f.virtualization.haloTileIds = ['B'];
  f.virtualization.haloBounds = [[-74.5, 40, -72.5, 41]];

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source)] });

  const nextData = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(nextData, firstData);
  assert.deepEqual([...nextData.attributes.getPath.value], [
    -74.5, 40.5,
    -74, 40.5,
    -73, 40.5,
    -72.5, 40.5,
  ]);
});

test('Portolan binary clipping rebuilds same-source geometry and attributes after revision change', () => {
  const f = fixture({ revision: 7 });
  const firstData = f.deck.props.layers[0].props.data;
  f.source.attributes.getPath.value[4] = -74.25;
  f.source.attributes.getOffsetVecs.value[4] = 20;
  f.source.attributes.getColor.value.set([99, 88, 77, 255], 8);
  f.setRevision(8);

  f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source)] });

  const nextData = f.deck.props.layers[0].props.data;
  assert.notStrictEqual(nextData, firstData);
  assert.equal(nextData.attributes.getPath.value[4], -74.25);
  assert.equal(nextData.attributes.getOffsetVecs.value[4], 20);
  assert.deepEqual([...nextData.attributes.getColor.value.slice(8, 12)], [99, 88, 77, 255]);
});

test('fresh Portolan binary source at the same revision clips independently', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ revision: 7 });
    const firstData = f.deck.props.layers[0].props.data;
    const replacement = binaryPaths();

    f.deck.setProps({ layers: [new Layer('portolan-ribbons', replacement)] });

    assert.notStrictEqual(f.deck.props.layers[0].props.data, firstData);
    assert.equal(clipCount(), 2);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});

test('unknown-revision hidden Portolan mutation reclips on reveal', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ revision: null });
    assert.equal(f.deck.props.layers[0].props.data.length, 1);
    f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source, false)] });
    f.source.attributes.getPath.value.set([
      -80, 40.5, -79, 40.5, -78, 40.5, -77, 40.5, -76, 40.5,
    ]);

    f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source, true)] });

    assert.equal(f.deck.props.layers[0].props.data.length, 0);
    assert.equal(clipCount(), 2);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});

test('Portolan under and over layers share one source clip but keep distinct sources separate', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ revision: 7 });
    f.deck.setProps({ layers: [
      new Layer('portolan-ribbons-under', f.source),
      new Layer('portolan-ribbons', f.source),
    ] });
    assert.equal(clipCount(), 1);
    assert.strictEqual(
      f.deck.props.layers[0].props.data,
      f.deck.props.layers[1].props.data,
      'the under/over pair may share clipped buffers only when it shares the native source',
    );

    f.deck.setProps({ layers: [
      new Layer('portolan-ribbons-under', binaryPaths()),
      new Layer('portolan-ribbons', binaryPaths()),
    ] });
    assert.equal(clipCount(), 3);
    assert.notStrictEqual(f.deck.props.layers[0].props.data, f.deck.props.layers[1].props.data);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});

test('hidden Portolan updates retain known-revision clipping for reveal', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ revision: 7 });
    const firstData = f.deck.props.layers[0].props.data;
    assert.equal(clipCount(), 1);

    f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source, false)] });
    f.deck.setProps({ layers: [new Layer('portolan-ribbons', f.source, true)] });

    assert.strictEqual(f.deck.props.layers[0].props.data, firstData);
    assert.equal(clipCount(), 1, 'a known unchanged revision makes the hidden interval safe');
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});

test('hidden GeoJSON route updates retain known-revision clipping for reveal', () => {
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
  try {
    const f = fixture({ revision: 7 });
    const source = [{
      type: 'Feature',
      properties: { routeIds: ['route-a'], offset: [-4, -2, 0, 2, 4] },
      geometry: {
        type: 'LineString',
        coordinates: [[-76, 40.5], [-75, 40.5], [-74, 40.5], [-73, 40.5], [-72, 40.5]],
      },
    }];
    f.deck.setProps({ layers: [new Layer('interlined-routes', source)] });
    const firstData = f.deck.props.layers[0].props.data;
    const clipsBeforeHiddenInterval = clipCount();

    f.deck.setProps({ layers: [new Layer('interlined-routes', source, false)] });
    f.deck.setProps({ layers: [new Layer('interlined-routes', source, true)] });

    assert.strictEqual(f.deck.props.layers[0].props.data, firstData);
    assert.equal(
      clipCount(),
      clipsBeforeHiddenInterval,
      'a known unchanged route revision makes the hidden interval safe',
    );
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalInfo;
  }
});
