import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RenderDistancePanel,
  registerRenderDistanceToolbar,
  renderDistanceLabel,
} from '../../../../open-world-platform/src/runtime/ui/render-distance-panel.js';

function findElement(node, type) {
  if (node?.type === type) return node;
  for (const child of node?.children ?? []) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

test('renders an accessible continuous kilometre slider and forwards changes to the overlay controller', () => {
  let requested = null;
  const controller = {
    getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }),
    subscribeRenderDistance: () => () => {},
    setRenderDistance: (value) => { requested = Number(value); },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (value) => [value, () => {}],
    useEffect: (effect) => effect(),
  };
  const panel = RenderDistancePanel({ React, controller });
  const slider = findElement(panel, 'input');
  assert.equal(slider.props.type, 'range');
  assert.equal(slider.props.min, 0);
  assert.equal(slider.props.max, 1000);
  assert.equal(slider.props.value, 200);
  assert.equal(slider.props['aria-valuetext'], '3 km');
  slider.props.onChange({ target: { value: '500' } });
  assert.equal(requested, 6);
});

test('registers the render-distance slider as a map rendering toolbar panel', () => {
  let definition = null;
  const React = { createElement: (type, props) => ({ type, props }) };
  const api = {
    utils: { React },
    ui: {
      unregisterComponent: () => {},
      addToolbarPanel: (value) => { definition = value; return 'registered'; },
    },
  };
  const result = registerRenderDistanceToolbar({ api, controller: {}, panelId: 'test-render-distance' });
  assert.equal(result.registration, 'registered');
  assert.equal(definition.id, 'test-render-distance');
  assert.equal(definition.title, 'Map rendering');
  assert.equal(definition.render().type, RenderDistancePanel);
  assert.equal(renderDistanceLabel(7), '7 km');
  assert.equal(renderDistanceLabel(8), '8 km');
  assert.equal(renderDistanceLabel(9), '9 km');
});

test('map rendering exposes the cached simulation toggle and its calculation status', () => {
  let requested;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const simulation = { snapshot: () => ({ enabled: true, status: 'calculating' }),
    subscribe: () => () => {}, setEnabled: value => { requested = value; } };
  const panel = RenderDistancePanel({ React, simulation,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  const nodes = function* (node) { if (!node || typeof node !== 'object') return; yield node; for (const child of node.children ?? []) yield* nodes(child); };
  const toggle = [...nodes(panel)].find(node => node.props.role === 'switch');
  assert.equal(toggle.props.checked, true);
  toggle.props.onChange({ target: { checked: false } });
  assert.equal(requested, false);
  assert.match(JSON.stringify(panel), /Calculating journeys/);
});

test('map rendering always exposes the experimental save toggle, disabled until the writer is configured', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: false, enabled: false, status: 'off', last: null, error: null }),
    subscribe: () => () => {}, setEnabled: () => { throw new Error('unconfigured writer must stay disabled'); } };
  const panel = RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  const nodes = function* (node) { if (!node || typeof node !== 'object') return; yield node; for (const child of node.children ?? []) yield* nodes(child); };
  const toggle = [...nodes(panel)].find(node => node.props?.['aria-label'] === 'Experimental tile-server autosaves');
  assert.ok(toggle, 'experimental save toggle must always be present');
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, true);
  assert.match(JSON.stringify(panel), /Save writer unavailable/);
});

test('opening the panel re-probes an unconfigured save writer', () => {
  let reconnects = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: false, enabled: false, status: 'off', last: null, error: null }),
    subscribe: () => () => {}, reconnect: () => { reconnects++; return Promise.resolve(); } };
  RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  assert.equal(reconnects, 1);
});

test('an in-progress experimental save shows the current uploaded size', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: true, enabled: true, status: 'saving',
      phase: 'uploading', elapsedMs: 12300, progress: 5 * 1048576, last: { bytes: 30 * 1048576, durationMs: 19000, encodeMs: 3000 }, error: null }),
    subscribe: () => () => {}, reconnect: () => Promise.resolve() };
  const panel = RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  assert.match(JSON.stringify(panel), /5\.0 MiB/);
  assert.match(JSON.stringify(panel), /Encoding and uploading/);
  assert.match(JSON.stringify(panel), /12\.3 s/);
  assert.match(JSON.stringify(panel), /Last completed save: encode 3\.0 s/);
});

test('a completed experimental save shows its size and phase timings', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: true, enabled: true, status: 'saved', transport: 'prototype',
      last: { bytes: 30 * 1048576, durationMs: 19000, generateMs: 2000, encodeMs: 3000, transferMs: 12000, settleMs: 500 }, error: null }),
    subscribe: () => () => {}, reconnect: () => Promise.resolve() };
  const panel = RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  const text = JSON.stringify(panel);
  assert.match(text, /30\.0 MiB/);
  assert.match(text, /19\.0 s/);
  assert.match(text, /encode 3\.0 s/);
  assert.match(text, /transfer 12\.0 s/);
});

test('a failed experimental attempt reports no save and offers an experimental retry', () => {
  let retries = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: true, enabled: true, status: 'failed', transport: 'prototype',
      last: null, error: 'Autosave was not saved: Game work is still changing the save. Native fallback is disabled.' }),
    subscribe: () => () => {}, reconnect: () => Promise.resolve(), run: async () => { retries++; } };
  const panel = RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  assert.match(JSON.stringify(panel), /Autosave was not saved/);
  assert.match(JSON.stringify(panel), /Retry experimental save/);
  const nodes = function* (node) { if (!node || typeof node !== 'object') return; yield node; for (const child of node.children ?? []) yield* nodes(child); };
  [...nodes(panel)].find(node => node.type === 'button' && node.children.includes('Retry experimental save')).props.onClick();
  assert.equal(retries, 1);
});

test('configured save writer enables the experimental save toggle', () => {
  let requested;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => effect(),
  };
  const saveWriter = { snapshot: () => ({ configured: true, enabled: false, status: 'ready', last: null, error: null }),
    subscribe: () => () => {}, setEnabled: value => { requested = value; } };
  const panel = RenderDistancePanel({ React, saveWriter,
    controller: { getRenderDistance: () => 3,
    getRenderDistanceLimits: () => ({ min: 1, max: 11 }), subscribeRenderDistance: () => () => {} } });
  const nodes = function* (node) { if (!node || typeof node !== 'object') return; yield node; for (const child of node.children ?? []) yield* nodes(child); };
  const toggle = [...nodes(panel)].find(node => node.props?.['aria-label'] === 'Experimental tile-server autosaves');
  assert.ok(toggle, 'configured experimental save toggle must be present');
  assert.equal(toggle.props.disabled, false);
  toggle.props.onChange({ target: { checked: true } });
  assert.equal(requested, true);
});
