import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/adapters/subway-builder-game-adapter.js';

function fixture() {
  const state = {
    routes: [{ id: 'route-pb', bullet: 'I', fullName: 'Silver Line', stNodes: [], idealTrainCount: 0 }],
    previewRoute: null,
    trains: [],
    tracks: [],
    trackGroups: [],
    signals: [],
    stNodes: [],
    stations: [],
    stationGroups: [],
    fareGroups: [],
    ownedTrainCount: 0,
    ownedCarsByType: { 'heavy-metro': 0 },
    setTimeConfig() {},
    setPreviewRoute(route) { state.previewRoute = route; },
    updateRouteProperty(routeId, key, value) {
      state.routes = state.routes.map((route) => (
        route.id === routeId ? { ...route, [key]: value } : route
      ));
    },
    confirmRouteChange() {
      if (!state.previewRoute) return { success: false };
      state.routes = state.routes.map((route) => (
        route.id === state.previewRoute.id ? structuredClone(state.previewRoute) : route
      ));
      state.previewRoute = null;
      return { success: true };
    },
    buyTrains(count, type) {
      state.ownedTrainCount += count;
      state.ownedCarsByType = {
        ...state.ownedCarsByType,
        [type]: (state.ownedCarsByType[type] ?? 0) + count,
      };
      return { success: true };
    },
    generateTrain(train) {
      state.trains = [...state.trains, train];
      return train;
    },
    spawnTrainAtStation(train) {
      state.trains = [...state.trains, train];
      return train;
    },
    deleteTrain(trainId) {
      state.trains = state.trains.filter((train) => train.id !== trainId);
    },
    resetTrains() {
      state.trains = [];
    },
    setTracks({ newTracks, newTrackGroups = state.trackGroups }) {
      state.tracks = newTracks;
      state.trackGroups = newTrackGroups;
    },
    updateStationName(stationId, { newName }) {
      state.stations = state.stations.map((station) => (
        station.id === stationId ? { ...station, name: newName } : station
      ));
    },
    setStationGroupCustomName(groupId, customName) {
      state.stationGroups = state.stationGroups.map((group) => (
        group.id === groupId ? { ...group, customName } : group
      ));
    },
    addFareGroup() {
      state.fareGroups = [...state.fareGroups, { id: `fare-${state.fareGroups.length + 1}` }];
      return state.fareGroups.at(-1);
    },
    generateRoute(route = { id: `route-${state.routes.length + 1}`, stNodes: [] }) {
      state.routes = [...state.routes, route];
      return route;
    },
    deleteRoute(routeId) {
      state.routes = state.routes.filter((route) => route.id !== routeId);
    },
  };
  return { state, callbacks: { getState: () => state } };
}

test('only confirmed route stop changes mark derived service state dirty', () => {
  const { state, callbacks } = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.setPreviewRoute({ ...state.routes[0], stNodes: [{ id: 'draft-stop' }] });
  assert.deepEqual(changes, [], 'an unconfirmed route preview must not become authoritative');

  state.confirmRouteChange();
  state.updateRouteProperty('route-pb', 'bullet', 'PB');
  state.buyTrains(2, 'heavy-metro');
  state.generateRoute({ id: 'blank-route', stNodes: [] });

  assert.deepEqual(changes, [{ reason: 'route-service-change' }]);
  assert.equal(state.routes[0].bullet, 'PB');
  assert.equal(state.ownedTrainCount, 2);
  assert.equal(state.ownedCarsByType['heavy-metro'], 2);
  dispose();
});

test('construction and naming wait for handoff while fare mutations mark calculations dirty', () => {
  const { state, callbacks } = fixture();
  state.stations = [{ id: 'station-1', name: 'Old Name' }];
  state.stationGroups = [{ id: 'group-1', customName: null }];
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.setTracks({
    newTracks: [{ id: 'track-1', buildType: 'constructed' }],
    newTrackGroups: [{ id: 'group-track-1', trackIds: ['track-1'] }],
  });
  state.updateStationName('station-1', { newName: 'New Name' });
  state.setStationGroupCustomName('group-1', 'Central Complex');
  state.addFareGroup();

  assert.deepEqual(changes, [{ reason: 'fare-policy-change' }]);
  dispose();
});

test('blueprint-only track mutations do not reconcile the authoritative network', () => {
  const { state, callbacks } = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.setTracks({
    newTracks: [{ id: 'draft-track', buildType: 'blueprint' }],
  });
  state.setTracks({ newTracks: [] });

  assert.deepEqual(changes, [], 'drawing or cancelling a blueprint must not start reconciliation');
  dispose();
});

test('route train-count changes mark service dirty without requesting eager work', () => {
  const { state, callbacks } = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.updateRouteProperty('route-pb', 'idealTrainCount', 2);

  assert.deepEqual(changes, [{ reason: 'route-service-change' }]);
  dispose();
});

test('deleting served routes is lazy service invalidation while blank routes stay quiet', () => {
  const { state, callbacks } = fixture();
  state.routes.push(
    { id: 'served-route', stNodes: [{ id: 'served-stop' }] },
    { id: 'blank-route', stNodes: [] },
  );
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.deleteRoute('blank-route');
  state.deleteRoute('served-route');

  assert.deepEqual(changes, [{ reason: 'route-service-change' }]);
  dispose();
});

test('automatic live train lifecycle does not invalidate the projection cache', () => {
  const { state, callbacks } = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  state.generateTrain({ id: 'generated', routeId: 'route-pb' });
  state.spawnTrainAtStation({ id: 'spawned', routeId: 'route-pb' });
  state.deleteTrain('generated');
  state.resetTrains();

  assert.deepEqual(changes, []);
  assert.deepEqual(state.trains, []);
  dispose();
});

test('installing the current observer removes a retained legacy train lifecycle wrapper', () => {
  const { state, callbacks } = fixture();
  const original = state.generateTrain;
  const legacyChanges = [];
  const legacyWrapper = function legacyObservedTrainLifecycle(...args) {
    const result = original.apply(this, args);
    legacyChanges.push('train-count-change');
    return result;
  };
  Object.defineProperties(legacyWrapper, {
    [Symbol.for('open-world.native-shared-transit-observer')]: { value: true },
    [Symbol.for('open-world.native-shared-transit-observer-version')]: { value: 1 },
    [Symbol.for('open-world.native-shared-transit-observer-original')]: { value: original },
  });
  state.generateTrain = legacyWrapper;

  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const dispose = adapter.observeSharedTransitChanges((change) => changes.push(change));

  assert.equal(state.generateTrain, original);
  state.generateTrain({ id: 'automatic', routeId: 'route-pb' });
  assert.deepEqual(legacyChanges, []);
  assert.deepEqual(changes, []);
  dispose();
});

test('observer replacement across hot reload does not retain the previous callback', () => {
  const { state, callbacks } = fixture();
  const first = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const firstChanges = [];
  first.observeSharedTransitChanges((change) => firstChanges.push(change));

  const second = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const secondChanges = [];
  const dispose = second.observeSharedTransitChanges((change) => secondChanges.push(change));
  state.updateRouteProperty('route-pb', 'idealTrainCount', 1);

  assert.deepEqual(firstChanges, []);
  assert.deepEqual(secondChanges, [{ reason: 'route-service-change' }]);
  dispose();
});

test('route count observation does not serialize unrelated route payloads', () => {
  const { state, callbacks } = fixture();
  state.routes.push({
    id: 'unrelated-route',
    stNodes: [],
    toJSON() { throw new Error('unrelated route was serialized'); },
  });
  const adapter = new SubwayBuilderGameAdapter({ callbacks, api: {} });
  const changes = [];
  const disposeObserver = adapter.observeSharedTransitChanges((change) => changes.push(change));

  assert.doesNotThrow(() => state.updateRouteProperty('route-pb', 'idealTrainCount', 2));
  assert.deepEqual(changes, [{ reason: 'route-service-change' }]);

  disposeObserver();
});
