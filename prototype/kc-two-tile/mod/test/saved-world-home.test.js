import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SavedWorldHomeComponent,
  registerSavedWorldHomeComponent,
  scheduleSavedWorldHomeRegistration,
} from '../src/ui/canonical-path-panel.js';

function treeNodes(tree) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(tree);
  return nodes;
}

test('registers saved-world loading in the native main-menu placement', () => {
  let registration;
  let unregistered;
  const api = {
    ui: {
      unregisterComponent: (placement, id) => { unregistered = { placement, id }; },
      registerComponent: (placement, definition) => {
        registration = { placement, definition };
        return definition;
      },
    },
    utils: { React: { createElement() {} } },
  };
  const selector = { listPaths: () => [], subscribe: () => () => {} };

  const result = registerSavedWorldHomeComponent({ api, selector });

  assert.equal(unregistered.placement, 'main-menu');
  assert.equal(unregistered.id, 'saved-world-home-load');
  assert.equal(registration.placement, 'main-menu');
  assert.equal(registration.definition.id, 'saved-world-home-load');
  assert.equal(typeof registration.definition.component, 'function');
  assert.equal(result.componentId, 'saved-world-home-load');
});

test('home component lists only user-saved worlds, loads a save, and starts a new game', async () => {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: (effect) => { effect(); },
  };
  const paths = [
    { id: 'configured', label: 'Configured world', worldId: 'configured-world', userSaved: false },
    { id: 'saved', label: 'My world', worldId: 'ny-lineage:one', userSaved: true, day: 4, routeCount: 2, wallet: 500, elapsedSeconds: 3_720 },
  ];
  const loaded = [];
  const created = [];
  const selector = {
    listPaths: () => paths,
    subscribe: () => () => {},
    initialize: () => Promise.resolve(),
  };

  const tree = SavedWorldHomeComponent({
    React,
    selector,
    onLoadWorld: async (path) => loaded.push(path),
    onNewWorld: async () => created.push(true),
  });
  const nodes = treeNodes(tree);
  const buttons = nodes.filter((node) => node.type === 'button');
  const text = nodes.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string').join(' ');

  assert.equal(tree.props['data-saved-world-home'], 'true');
  assert.equal(buttons.length, 2);
  assert.match(text, /Open World/);
  assert.match(text, /Load saved world/);
  assert.doesNotMatch(text, /Continue one of your saved worlds/);
  assert.match(text, /My world/);
  assert.match(text, /New Game/);
  assert.doesNotMatch(text, /Configured world/);
  await buttons[0].props.onClick();
  await buttons[1].props.onClick();
  assert.deepEqual(loaded, [paths[1]]);
  assert.deepEqual(created, [true]);
});

test('defers home registration until after native game-end UI cleanup', () => {
  let registered = true;
  let deferredRestore;
  const result = scheduleSavedWorldHomeRegistration(
    () => { registered = true; },
    (callback) => { deferredRestore = callback; return 'scheduled'; },
  );

  assert.equal(result, 'scheduled');
  registered = false;
  deferredRestore();
  assert.equal(registered, true);
});
