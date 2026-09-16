import { TILE_SAVE_PROTOTYPE_VERSION, writePrototypeNativeSave } from './prototype-tile-save-client.js';

const STREAM_SAVE = Symbol.for('open-world.stream-native-save');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

// Experimental, session-local transport. Native generation/validation, cached
// clock rebasing and the ordinary native load UI remain authoritative.
export function createPrototypeSaveController({ getState, isReady = () => true,
  isBusy = () => false, freezeUi = blockSaveEdits, yieldTask = nextFrame,
  writeSave = writePrototypeNativeSave, onActivity = () => {}, fetchFn = fetch } = {}) {
  let configuration = null, enabled = false, pending = null, automatic = null, abort = null, disposed = false;
  const listeners = new Set();
  let status = { version: TILE_SAVE_PROTOTYPE_VERSION, controllerVersion: 'tile-save-controller-v2', configured: false, enabled: false, status: 'off', last: null, error: null };
  const snapshot = () => ({ ...status, enabled, configured: Boolean(configuration) });
  const notify = () => { for (const listener of listeners) { try { listener(snapshot()); } catch {} } };
  const activity = (stage, data = {}) => { try { onActivity(`tile-save.${stage}`, data); } catch {} };

  async function capture() {
    if (disposed || !configuration || !isReady()) throw new Error('Tile save prototype is not ready');
    const state = getState(), session = state.gameSessionId, city = state.cityCode;
    if (typeof state.setTimeConfig !== 'function' || !session || !city) throw new Error('Unsupported game state');
    const originallyPaused = state.timeConfig.paused;
    const localAbort = abort = new AbortController();
    const ui = freezeUi(() => localAbort.abort(new Error('Normal save requested')));
    status = { ...status, status: 'saving', error: null }; notify(); activity('start');
    const sameContext = () => getState().gameSessionId === session && getState().cityCode === city;
    try {
      state.setTimeConfig({ paused: true });
      // Let the current native tick and UI updates settle before taking the
      // snapshot. Active routing/midnight work keeps the native save path.
      await yieldTask(); await yieldTask();
      if (!sameContext() || !isReady() || isBusy()) throw new Error('Game work is still changing the save');
      const stable = getState();
      const generated = performance.now();
      let save = await stable.generateSave({ name: `[Auto] Tile server ${new Date().toISOString().replaceAll(':', '-')}`, [STREAM_SAVE]: true });
      const generateMs = performance.now() - generated;
      if (save.version !== 4) throw new Error('Prototype supports native save schema 4 only');
      const settled = getState();
      const clock = settled.timeConfig.elapsedSeconds, money = settled.money;
      const roots = ['tracks', 'trains', 'routes', 'stations', 'financialHistory', 'bonds', 'demandData', 'completedCommutes'];
      // Eight pointers pin the pre-save arrays while the transfer runs. They
      // are released in the finally below as soon as the writer settles so a
      // large snapshot cannot outlive its upload.
      let references = roots.map(key => settled[key]);
      const stabilitySummary = { clock, money,
        session, city, sizes: Object.fromEntries(roots.map((key, index) =>
          [key, Array.isArray(references[index]) ? references[index].length : references[index] === undefined ? 0 : 1])) };
      const assertStable = () => {
        localAbort.signal.throwIfAborted();
        if (!references) throw new Error('Save stability snapshot was released; partial save discarded');
        const current = getState();
        if (!sameContext() || !current.timeConfig.paused || current.timeConfig.elapsedSeconds !== clock
          || current.money !== money || roots.some((key, index) => current[key] !== references[index]) || isBusy())
          throw new Error('Game state changed while streaming; partial save discarded');
      };
      assertStable();
      // The temporary UI pause is not a change to the player's saved settings.
      save.data = { ...save.data, timeConfig: { ...save.data.timeConfig, paused: originallyPaused } };
      let result;
      try {
        result = await writeSave(save, { ...configuration, fetchFn, signal: localAbort.signal,
          beforeCommit: assertStable,
          onProgress: progress => { assertStable(); ui.progress(progress); status.progress = progress.bytes; notify(); },
        });
      } finally {
        references = null;
        save = null;
      }
      status = { ...status, status: 'saved', progress: result.bytes, last: { ...result, generateMs, stabilitySummary } };
      activity('complete', { durationMs: result.durationMs, bytes: result.bytes, generateMs }); notify();
      return result;
    } catch (error) {
      status = { ...status, status: 'failed', error: String(error.message) }; notify(); activity('error'); throw error;
    } finally {
      ui.dispose(); abort = null;
      if (sameContext() && !originallyPaused) getState().setTimeConfig({ paused: false });
    }
  }
  const run = () => {
    if (pending) return pending;
    pending = capture().finally(() => { pending = null; });
    return pending;
  };
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async configure({ origin, token }) {
      if (pending || disposed) throw new Error('Cannot configure an active save');
      const base = new URL(origin);
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || typeof token !== 'string' || token.length < 16)
        throw new Error('Expected an authenticated loopback tile server');
      const response = await fetchFn(new URL('/_prototype/save/status', base), { method: 'POST',
        headers: { 'X-PMTiles-Control-Token': token }, signal: AbortSignal.timeout(3000) });
      if (!response.ok || (await response.json()).version !== TILE_SAVE_PROTOTYPE_VERSION) throw new Error('Prototype writer is unavailable');
      configuration = { origin: base.origin, token }; status.status = 'ready'; notify(); return snapshot();
    },
    setEnabled(value) {
      if (value && (!configuration || disposed)) throw new Error('Configure the prototype writer first');
      enabled = Boolean(value); notify(); return snapshot();
    },
    run,
    invoke(native) {
      if (!enabled || disposed) return native();
      if (automatic) return automatic;
      const session = getState().gameSessionId, city = getState().cityCode;
      automatic = run().catch(error => {
        enabled = false; notify(); activity('native-fallback', { error: String(error.message) });
        if (!disposed && isReady() && getState().gameSessionId === session && getState().cityCode === city) return native();
      }).finally(() => { automatic = null; });
      return automatic;
    },
    dispose() { disposed = true; enabled = false; configuration = null; abort?.abort(); listeners.clear(); },
  };
}

export function blockSaveEdits(cancel, { document = globalThis.document, window = globalThis.window } = {}) {
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Writing experimental autosave');
  panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(12,18,25,.88);color:white;display:grid;place-content:center;gap:16px;font:18px system-ui;';
  const message = document.createElement('div'); message.textContent = 'Writing experimental autosave…';
  const detail = document.createElement('div'); detail.textContent = 'Simulation and editing resume when the save completes.';
  detail.style.fontSize = '14px';
  const button = document.createElement('button'); button.textContent = 'Use normal save';
  panel.append(message, detail, button);
  const previousFocus = document.activeElement;
  document.body.append(panel); button.focus();
  const block = event => {
    // The focused button must not let Space or other game shortcuts bubble to
    // native handlers while the snapshot contains references to live objects.
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.target === button && (event.type === 'click'
      || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ')))) cancel();
  };
  const events = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'contextmenu'];
  for (const event of events) window.addEventListener(event, block, { capture: true, passive: false });
  return {
    progress: value => { message.textContent = `Writing experimental autosave — ${(value.bytes / 1048576).toFixed(1)} MiB`; },
    dispose() { for (const event of events) window.removeEventListener(event, block, true); panel.remove(); if (previousFocus?.isConnected) previousFocus.focus?.(); },
  };
}
