import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPrototypePanel, TileAtlasPanel } from '../src/ui/prototype-panel.js';

test('registers a zoomable catalog-driven tile atlas and switches the selected tile', async () => {
  let panel;
  let activeTileId = 'KCW';
  const staged = [];
  const reloads = [];
  const api = {
    ui: { addToolbarPanel: (definition) => { panel = definition; }, showNotification() {} },
    utils: {
      React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    },
  };
  const runtime = {
    view: () => ({
      activeTileId,
      commutes: { present: 10, waitingToLeave: 2, inboundInTransit: 1, outboundInTransit: 3, globalBacklog: 2 },
      commutesByTile: {
        KCW: { present: 10, waitingToLeave: 2, inboundInTransit: 1 },
        KCE: { present: 8, waitingToLeave: 1, inboundInTransit: 2 },
      },
    }),
    stageNavigationTransition: async (tileId) => {
      staged.push(tileId); activeTileId = tileId;
      return { worldId: 'world-1', tileId };
    },
  };
  const navigation = { navigateTo: (transition) => reloads.push(transition) };

  const controller = registerPrototypePanel({ api, runtime, navigation });

  assert.equal(panel.id, 'kc-two-tile-switcher');
  assert.equal(panel.icon, 'Map');
  assert.equal(panel.width, 368);
  assert.equal(panel.render().type, TileAtlasPanel);
  assert.deepEqual(controller.snapshot().tiles.map(({ id }) => id), ['KCW', 'KCE']);
  assert.equal(controller.snapshot().activeTileId, 'KCW');

  controller.setHoveredTile('KCE');
  assert.equal(controller.snapshot().hoveredTileId, 'KCE');
  const initialZoom = controller.snapshot().mapView.zoom;
  controller.zoomBy(1);
  assert.equal(controller.snapshot().mapView.zoom, initialZoom + 1);

  assert.equal((await controller.switchTo('KCW')).status, 'already-active');
  await controller.switchTo('KCE');
  assert.deepEqual(staged, ['KCE']);
  assert.deepEqual(reloads, [{ worldId: 'world-1', tileId: 'KCE' }]);
  assert.equal(controller.snapshot().activeTileId, 'KCE');
});

test('loaded game city overrides stale runtime selection and cannot navigate to itself', async () => {
  const staged = [];
  const api = {
    ui: { addToolbarPanel() {}, showNotification() {} },
    utils: {
      getCityCode: () => 'KCE',
      React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    },
  };
  const controller = registerPrototypePanel({
    api,
    runtime: {
      view: () => ({ activeTileId: 'KCW', commutes: { globalBacklog: 0 }, commutesByTile: {} }),
      stageNavigationTransition: async (tileId) => { staged.push(tileId); return { worldId: 'world-1', tileId }; },
    },
    navigation: { navigateTo() {} },
  });

  assert.equal(controller.snapshot().activeTileId, 'KCE');
  assert.equal(controller.snapshot().tiles.find((tile) => tile.active)?.id, 'KCE');
  assert.equal((await controller.switchTo('KCE')).status, 'already-active');
  assert.deepEqual(staged, []);
});

test('atlas component renders one keyboard-selectable polygon per catalog tile', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [0, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  const runtime = {
    view: () => ({ activeTileId: 'KCW', commutes: { globalBacklog: 0 }, commutesByTile: {} }),
  };
  const controller = registerPrototypePanel({
    api: {
      ui: { addToolbarPanel() {}, showNotification() {} },
      utils: { React },
    },
    runtime,
    navigation: { navigateTo() {} },
  });

  const tree = TileAtlasPanel({ React, controller });
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(tree);
  const polygons = nodes.filter((node) => node.type === 'polygon');
  assert.equal(polygons.length, 2);
  assert.deepEqual(polygons.map((node) => node.props['aria-label']), ['West, current tile', 'East, switch tile']);
  assert.ok(polygons.every((node) => node.props.tabIndex === 0 && node.props.role === 'button'));
  assert.equal(nodes.some((node) => node.type === 'button'), false);
  const text = nodes.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string').join(' ');
  assert.doesNotMatch(text, /drag|scroll|zoom|click the highlighted|grid z/i);
});

test('atlas wheel zoom does not call preventDefault from React passive listener', () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [0, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  const controller = registerPrototypePanel({
    api: {
      ui: { addToolbarPanel() {}, showNotification() {} },
      utils: { React },
    },
    runtime: {
      view: () => ({ activeTileId: 'KCW', commutes: { globalBacklog: 0 }, commutesByTile: {} }),
    },
    navigation: { navigateTo() {} },
  });

  const tree = TileAtlasPanel({ React, controller });
  let svg;
  const findSvg = (node) => {
    if (!node || typeof node !== 'object' || svg) return;
    if (node.type === 'svg') { svg = node; return; }
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(findSvg); else findSvg(child);
    }
  };
  findSvg(tree);
  assert.ok(svg);
  let prevented = false;
  let propagationStopped = false;
  const initialZoom = controller.snapshot().mapView.zoom;
  svg.props.onWheel({
    deltaY: -1,
    clientX: 120,
    clientY: 80,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 336, height: 248 }) },
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { propagationStopped = true; },
  });

  assert.equal(prevented, false);
  assert.equal(propagationStopped, true);
  assert.equal(controller.snapshot().mapView.zoom, initialZoom + 0.5);
});

test('a captured pointer release selects its tile without relying on a polygon click event', async () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [0, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  const staged = [];
  const controller = registerPrototypePanel({
    api: {
      ui: { addToolbarPanel() {}, showNotification() {} },
      utils: { React },
    },
    runtime: {
      view: () => ({ activeTileId: 'KCW', commutes: { globalBacklog: 0 }, commutesByTile: {} }),
      stageNavigationTransition: async (tileId) => {
        staged.push(tileId);
        return { worldId: 'world-1', tileId };
      },
    },
    navigation: { navigateTo() {} },
  });

  const tree = TileAtlasPanel({ React, controller });
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(tree);
  const svg = nodes.find((node) => node.type === 'svg');
  const eastTile = nodes.find((node) => node.type === 'polygon' && node.props['aria-label'] === 'East, switch tile');
  const pointerTarget = { setPointerCapture() {}, releasePointerCapture() {} };
  const eastTileTarget = { dataset: { tileId: 'KCE' } };

  svg.props.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100, currentTarget: pointerTarget, target: eastTileTarget });
  svg.props.onPointerMove({ pointerId: 1, clientX: 102, clientY: 101, currentTarget: pointerTarget, target: pointerTarget });
  svg.props.onPointerUp({ pointerId: 1, clientX: 102, clientY: 101, currentTarget: pointerTarget, target: pointerTarget });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(staged, ['KCE']);

  eastTile.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(staged, ['KCE']);

  svg.props.onPointerDown({ pointerId: 2, clientX: 100, clientY: 100, currentTarget: pointerTarget, target: eastTileTarget });
  svg.props.onPointerMove({ pointerId: 2, clientX: 110, clientY: 100, currentTarget: pointerTarget });
  svg.props.onPointerUp({ pointerId: 2, clientX: 110, clientY: 100, currentTarget: pointerTarget });
  eastTile.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(staged, ['KCE']);

  svg.props.onPointerDown({ pointerId: 3, clientX: 120, clientY: 120, currentTarget: pointerTarget, target: eastTileTarget });
  svg.props.onPointerMove({ pointerId: 3, clientX: 130, clientY: 120, currentTarget: pointerTarget });
  svg.props.onPointerUp({ pointerId: 3, clientX: 130, clientY: 120, currentTarget: pointerTarget });
  svg.props.onPointerDown({ pointerId: 4, clientX: 140, clientY: 140, currentTarget: pointerTarget, target: eastTileTarget });
  svg.props.onPointerUp({ pointerId: 4, clientX: 140, clientY: 140, currentTarget: pointerTarget });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(staged, ['KCE', 'KCE']);
});
