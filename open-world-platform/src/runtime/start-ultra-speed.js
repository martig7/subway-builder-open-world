import { createCachedSimulation } from './cached-simulation.js';
import { SubwayBuilderGameAdapter } from './adapters/subway-builder-game-adapter.js';
import { installNativeSharedTransitObserver } from './adapters/native-shared-transit-observer.js';
import { createRuntimeModePreferences } from './runtime-mode-preferences.js';
import { ultraSpeedWorldOwner, subscribeUltraSpeedOwnership } from './ultra-speed-ownership.js';
import { UltraSpeedControl } from './ui/ultra-speed-control.js';

export const ULTRA_SPEED_STANDALONE_VERSION = 'ultra-speed-standalone-v4-capacity';
export const ULTRA_SPEED_MOD_ID = 'gcm.ultra-speed';
const KEY = '__subwayBuilderUltraSpeedModV1__';
const PANEL = 'ultra-speed-controls';

/** A native-city consumer of the shared estimator; no World or Tile Packages. */
export async function startUltraSpeed({ api = globalThis.SubwayBuilderAPI,
  callbacks = globalThis.__subwayBuilder_storeCallbacks__, workerSources = {}, storage,
  game = null, eventTarget = globalThis.window } = {}) {
  if (!api || typeof callbacks?.getState !== 'function') throw new Error('Ultra speed requires Subway Builder Mod API 1.0.0.');
  await globalThis[KEY]?.dispose?.();
  const preferences = createRuntimeModePreferences({ modId: ULTRA_SPEED_MOD_ID, storage });
  const getState = () => callbacks.getState();
  const listeners = new Set(), unsubscribers = [];
  let disposed = false, available = true, simulation = null, detachObserver = null, detachSimulation = null;
  let context = null, epoch = 0, pending = Promise.resolve(), teardown = Promise.resolve(), error = null;
  let disposal = null;
  // World controllers survive leaving their city. Reserve the entire native
  // store while a World consumer is enabled, including dormant consumers.
  const owner = () => ultraSpeedWorldOwner(null, api.mods);
  const loaded = () => available && getState()?.gameSessionId && getState()?.cityCode
    && getState()?.demandData?.popsMap instanceof Map && getState()?.demandData?.points instanceof Map;
  const snapshot = () => ({ ...(simulation?.snapshot() ?? {}),
    version: ULTRA_SPEED_STANDALONE_VERSION, simulationVersion: simulation?.snapshot().version ?? null, enabled: preferences.snapshot().ultraHighSpeed,
    status: owner() ? 'open-world' : !loaded() ? 'unavailable'
      : simulation?.snapshot().status ?? 'restoring', worldOwner: owner(), error: error ?? simulation?.snapshot().error ?? null });
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const retire = () => {
    const previous = simulation;
    simulation = null; context = null;
    detachObserver?.(); detachObserver = null;
    detachSimulation?.(); detachSimulation = null;
    if (previous) teardown = Promise.all([teardown, previous.dispose()]);
  };
  const reconcile = ({ reset = false } = {}) => {
    const token = ++epoch, state = getState();
    if (reset || owner() || !loaded() || (context && (context[0] !== state.gameSessionId || context[1] !== state.cityCode))) retire();
    notify();
    pending = pending.catch(() => {}).then(async () => {
      await teardown;
      if (disposed || token !== epoch) return;
      // A World may become visible in the host registry after its synchronous
      // registration callback, while this reconciliation waits for teardown.
      if (owner() || !loaded()) { retire(); notify(); await teardown; return; }
      if (!simulation) {
        game ??= new SubwayBuilderGameAdapter({ api, callbacks });
        await game.assertSupported();
        if (disposed || token !== epoch || owner() || !loaded()) return;
        const initial = getState();
        context = [initial.gameSessionId, initial.cityCode];
        const isReady = () => !disposed && loaded() && !owner()
          && getState().gameSessionId === initial.gameSessionId && getState().cityCode === initial.cityCode;
        simulation = createCachedSimulation({ game, api, getState, isReady,
          workerSource: workerSources.nativeDemandEvaluator, postingWorkerSource: workerSources.hourlyFinance,
          onDay: day => simulation?.refreshAtMidnight(day) });
        detachSimulation = simulation.subscribe(notify);
        detachObserver = installNativeSharedTransitObserver(callbacks, () => { if (isReady()) simulation?.invalidate(); });
      }
      await simulation.setEnabled(preferences.snapshot().ultraHighSpeed);
      error = null; notify();
    }).catch(failure => { error = String(failure?.message ?? failure); notify(); });
    return pending;
  };
  const controls = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setEnabled(value) {
      if (disposed || owner()) return snapshot();
      preferences.setUltraHighSpeed(value);
      // Cancel preparation immediately; queued reconciliation may still be
      // waiting for a native wave or worker from the enable request.
      if (!value) void simulation?.setEnabled(false);
      await reconcile(); return snapshot();
    },
    async dispose() {
      if (disposal) return disposal;
      disposed = true; epoch++; retire();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
      api.ui?.unregisterComponent?.('top-bar', PANEL);
      disposal = (async () => { await pending; await teardown; listeners.clear();
        if (globalThis[KEY] === controls) delete globalThis[KEY]; })();
      return disposal;
    },
    whenIdle: () => pending,
  };
  globalThis[KEY] = controls;
  const hook = (name, callback) => {
    const unsubscribe = api.hooks?.[name]?.(callback);
    if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
  };
  for (const name of ['onGameInit', 'onGameLoaded']) hook(name, () => { available = true; return reconcile({ reset: true }); });
  // Native city-load follows data loading and is replayed after map-ready
  // during hot reload. It cannot be treated as the start of a pending load.
  hook('onCityLoad', () => { available = true; return reconcile({ reset: true }); });
  hook('onMapReady', () => { available = true; return reconcile(); });
  hook('onGameEnd', () => { available = false; return reconcile(); });
  for (const name of ['onScheduleChange', 'onTicketPriceChanged', 'onFareGroupsChanged']) {
    hook(name, () => simulation?.invalidate());
  }
  unsubscribers.push(subscribeUltraSpeedOwnership(() => { void reconcile(); }));
  if (eventTarget?.addEventListener) {
    const onReload = () => { void reconcile(); };
    eventTarget.addEventListener('modding-api-reload-complete', onReload);
    unsubscribers.push(() => eventTarget.removeEventListener('modding-api-reload-complete', onReload));
  }
  const React = api.utils?.React;
  if (React?.createElement && api.ui?.addToolbarPanel) {
    api.ui.unregisterComponent?.('top-bar', PANEL);
    api.ui.addToolbarPanel({ id: PANEL, icon: 'FastForward', tooltip: 'Ultra speed', title: 'Ultra speed', width: 340,
      render: () => React.createElement('div', { className: 'p-3' },
        React.createElement(UltraSpeedControl, { React, simulation: controls, id: 'ultra-speed-enabled', hideTrains: false })) });
  }
  await reconcile();
  return controls;
}
