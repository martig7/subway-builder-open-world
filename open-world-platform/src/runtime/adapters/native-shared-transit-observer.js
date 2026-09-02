const NATIVE_SHARED_TRANSIT_OBSERVER = Symbol.for('open-world.native-shared-transit-observer');
const NATIVE_SHARED_TRANSIT_OBSERVER_VERSION = Symbol.for('open-world.native-shared-transit-observer-version');
const NATIVE_SHARED_TRANSIT_OBSERVER_ORIGINAL = Symbol.for('open-world.native-shared-transit-observer-original');
const CURRENT_NATIVE_SHARED_TRANSIT_OBSERVER_VERSION = 4;
export const TRAIN_STATE_BOUNDARIES_VERSION = 'native-derived-state-lazy-v1';

// Hot reload can retain wrappers from older observer generations. Keep the
// complete historical action list so installing the lazy observer also
// removes wrappers for actions which no longer need observation at all.
const LEGACY_OBSERVED_ACTIONS = Object.freeze([
  'setTracks',
  'generateRoute',
  'duplicateRoute',
  'deleteRoute',
  'updateRouteProperty',
  'confirmRouteChange',
  'convertRouteTrainType',
  'updateStationName',
  'updateStationType',
  'addStationToGroup',
  'removeStationFromGroup',
  'resetStationGroup',
  'setStationGroupManualCenter',
  'setStationGroupCustomName',
  'setFareGroups',
  'updateFareGroup',
  'addFareGroup',
  'deleteFareGroup',
  'buyTrains',
  'setOwnedTrainCount',
  'generateTrain',
  'spawnTrainAtStation',
  'deleteTrain',
  'resetTrains',
]);

const SERVICE_ROUTE_PROPERTIES = new Set([
  'idealTrainCount',
  'trainSchedule',
  'schedule',
  'frequency',
  'timetable',
]);

const SERVICE_EVENT = Object.freeze({ reason: 'route-service-change' });
const FARE_EVENT = Object.freeze({ reason: 'fare-policy-change' });

function idOf(value) {
  if (value && typeof value === 'object') return value.id == null ? null : String(value.id);
  return value == null ? null : String(value);
}

function routeById(state, routeId) {
  if (routeId == null) return null;
  return (state?.routes ?? []).find((route) => String(route?.id) === String(routeId)) ?? null;
}

function routeStopSignature(route) {
  if (!route) return null;
  return (route.stNodes ?? []).map((node) => String(
    node?.stationId ?? node?.id ?? node?.stNodeId ?? '',
  )).join('\u0000');
}

function captureRouteProperty(state, args) {
  const routeId = idOf(args[0]);
  const property = args[1];
  return {
    routeId,
    property,
    value: routeById(state, routeId)?.[property],
  };
}

function routePropertyEvent({ before, after }) {
  if (!SERVICE_ROUTE_PROPERTIES.has(before?.property)) return null;
  const next = routeById(after, before.routeId)?.[before.property];
  return Object.is(before.value, next) ? null : SERVICE_EVENT;
}

function capturePreviewRoute(state) {
  const routeId = idOf(state?.previewRoute);
  return {
    routeId,
    stopSignature: routeStopSignature(routeById(state, routeId)),
  };
}

function confirmedRouteEvent({ before, after }) {
  if (!before?.routeId) return null;
  const nextSignature = routeStopSignature(routeById(after, before.routeId));
  return before.stopSignature === nextSignature ? null : SERVICE_EVENT;
}

function captureDeletedRoute(state, args) {
  const route = routeById(state, idOf(args[0]));
  return { hadStops: Boolean(routeStopSignature(route)) };
}

function deletedRouteEvent({ before }) {
  return before?.hadStops ? SERVICE_EVENT : null;
}

const ACTIONS = Object.freeze([
  {
    name: 'updateRouteProperty',
    capture: captureRouteProperty,
    event: routePropertyEvent,
  },
  {
    name: 'confirmRouteChange',
    capture: capturePreviewRoute,
    event: confirmedRouteEvent,
  },
  {
    name: 'deleteRoute',
    capture: captureDeletedRoute,
    event: deletedRouteEvent,
  },
  { name: 'convertRouteTrainType', event: () => SERVICE_EVENT },
  { name: 'updateStationType', event: () => SERVICE_EVENT },
  { name: 'addStationToGroup', event: () => SERVICE_EVENT },
  { name: 'removeStationFromGroup', event: () => SERVICE_EVENT },
  { name: 'resetStationGroup', event: () => SERVICE_EVENT },
  { name: 'setFareGroups', event: () => FARE_EVENT },
  { name: 'updateFareGroup', event: () => FARE_EVENT },
  { name: 'addFareGroup', event: () => FARE_EVENT },
  { name: 'deleteFareGroup', event: () => FARE_EVENT },
]);

function reportChange(changed, event) {
  if (!event) return;
  try {
    changed(event);
  } catch (error) {
    console.warn('[OpenWorld] native shared-transit observer callback failed', error);
  }
}

/**
 * Observe committed service/fare edits which Subway Builder 1.6 does not
 * expose completely through public hooks. Native saves own topology; these
 * observations only mark derived calculations stale. Inventory, live trains,
 * construction, blueprints, labels, and blank route design stay off the click
 * path and are captured naturally at save/tile-handoff boundaries.
 */
export function installNativeSharedTransitObserver(callbacks, changed) {
  if (typeof callbacks?.getState !== 'function' || typeof changed !== 'function') return () => {};
  const state = callbacks.getState();
  if (!state) return () => {};
  const installed = [];
  globalThis.__openWorldTrainStateBoundariesVersion = TRAIN_STATE_BOUNDARIES_VERSION;

  for (const name of LEGACY_OBSERVED_ACTIONS) {
    const current = state[name];
    const original = current?.[NATIVE_SHARED_TRANSIT_OBSERVER_ORIGINAL];
    if (current?.[NATIVE_SHARED_TRANSIT_OBSERVER] === true && typeof original === 'function') {
      state[name] = original;
    }
  }

  for (const spec of ACTIONS) {
    const current = state[spec.name];
    if (typeof current !== 'function') continue;
    const original = current[NATIVE_SHARED_TRANSIT_OBSERVER_ORIGINAL] ?? current;
    const wrapped = function observedNativeSharedTransitAction(...args) {
      const before = spec.capture?.(callbacks.getState?.(), args) ?? null;
      const result = original.apply(this, args);
      const finish = (value) => {
        const after = callbacks.getState?.();
        reportChange(changed, spec.event?.({ args, before, after, value }) ?? null);
        return value;
      };
      return result && typeof result.then === 'function'
        ? Promise.resolve(result).then(finish)
        : finish(result);
    };
    Object.defineProperties(wrapped, {
      [NATIVE_SHARED_TRANSIT_OBSERVER]: { value: true },
      [NATIVE_SHARED_TRANSIT_OBSERVER_VERSION]: { value: CURRENT_NATIVE_SHARED_TRANSIT_OBSERVER_VERSION },
      [NATIVE_SHARED_TRANSIT_OBSERVER_ORIGINAL]: { value: original },
    });
    state[spec.name] = wrapped;
    installed.push({ name: spec.name, original, wrapped });
  }

  state.setTimeConfig?.({});

  return () => {
    const live = callbacks.getState?.();
    if (!live) return;
    let restored = false;
    for (const { name, original, wrapped } of installed) {
      if (live[name] !== wrapped) continue;
      live[name] = original;
      restored = true;
    }
    if (restored) live.setTimeConfig?.({});
  };
}
