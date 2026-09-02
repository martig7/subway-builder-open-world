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

test('renders an accessible 1-9 slider and forwards changes to the overlay controller', () => {
  let requested = null;
  const controller = {
    getRenderDistance: () => 3,
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
  assert.equal(slider.props.min, 1);
  assert.equal(slider.props.max, 9);
  assert.equal(slider.props.value, 3);
  assert.equal(slider.props['aria-valuetext'], '3 × 3 tiles (default)');
  slider.props.onChange({ target: { value: '6' } });
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
  assert.equal(renderDistanceLabel(7), '7 × 7 tiles');
  assert.equal(renderDistanceLabel(8), '7 × 7 plus five tiles on each side');
  assert.equal(renderDistanceLabel(9), '9 × 9 tiles');
});
