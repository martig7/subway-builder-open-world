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
