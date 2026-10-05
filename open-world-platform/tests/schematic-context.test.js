import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSchematicContext, schematicContextRegistry } from '../src/runtime/schematic-context.js';

const definition = { identity: { manifestId: 'provider', worldId: 'world' }, map: { basemapRevision: 'coast', worldContextTileId: 'context' }, tileViews: { initialTileId: 'west' } };
const tileCatalog = { maxZoom: 15, tiles: [{ id: 'west', bounds: [0, 20, 5, 25] }, { id: 'east', bounds: [5, 20, 10, 25] }] };
const install = (root, state) => registerSchematicContext({ root, definition, tileCatalog, tileUrl: c => `${c.tileId}/{z}/{x}/{y}.mvt`,
  readState: () => state, loadVegetation: async () => ({ type: 'FeatureCollection', features: [] }) });

test('context reports world coverage and dedicated coastline without topology or finance', async () => {
  const root = {}, state = { owned: true, cityCode: 'west', sessionId: 'save', ready: true, generation: 1 };
  const provider = install(root, state), registry = root.SubwayBuilderOpenWorld;
  const a = registry.getContext();
  assert.deepEqual(a.bounds, [0, 20, 10, 25]);
  assert.equal(a.sources[0].source.maxzoom, 9);
  assert.deepEqual(a.sources[0].source.tiles, ['context/{z}/{x}/{y}.mvt']);
  assert.ok(Object.isFrozen(a.sources[0].bounds));
  assert.equal(a.routes, undefined);
  assert.equal(a.finance, undefined);
  state.cityCode = 'east'; provider.refresh();
  const b = registry.getContext();
  assert.equal(a.worldId, b.worldId); assert.ok(b.epoch > a.epoch);
  provider.refresh(true); assert.equal(registry.getContext().topologyRevision, 1);
  state.ready = false; assert.equal(registry.getContext().ready, false);
  state.owned = false; assert.equal(registry.getContext(), null);
  provider.dispose();
});

test('subscribers survive late registration and retired providers cannot remove replacements', () => {
  const root = {}, registry = schematicContextRegistry(root), events = [];
  const stop = registry.subscribe(() => events.push(registry.getContext()));
  const state = { owned: true, cityCode: 'west', ready: true };
  const old = install(root, state);
  const generation = registry.getContext().providerGeneration;
  const next = install(root, state);
  assert.ok(registry.getContext().providerGeneration > generation);
  old.dispose();
  assert.ok(registry.getContext());
  old.refresh(true); assert.equal(events.length, 2);
  next.dispose(); assert.equal(events.at(-1), null);
  stop(); install(root, state); assert.equal(events.length, 3);
});
