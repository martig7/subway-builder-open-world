import { TILE_SAVE_PROTOTYPE_VERSION, slimExperimentalSaveDemand, writePrototypeNativeSave } from './prototype-tile-save-client.js';
import { prototypeSaveProgressText } from './prototype-save-progress.js';

const STREAM_SAVE = Symbol.for('open-world.stream-native-save');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

// Experimental transport. Native generation/validation, cached
// clock rebasing and the ordinary native load UI remain authoritative.
const SAVE_GATE = 'prototype-save-gate';
const gateError = message => Object.assign(new Error(message), { code: SAVE_GATE });

// Match Subway Builder's native autosave service, using local calendar time.
function nativeAutosaveName() {
  const time = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `[Auto] ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}_${pad(time.getHours())}-${pad(time.getMinutes())}-${pad(time.getSeconds())}`;
}

export function createPrototypeSaveController({ getState, isReady = () => true,
  isBusy = () => false, freezeUi = blockSaveEdits, yieldTask = nextFrame,
  writeSave = writePrototypeNativeSave, onActivity = () => {}, fetchFn = fetch,
  settleMs = 30000, initialEnabled = false, onEnabledChange = () => {} } = {}) {
  let configuration = null, enabled = initialEnabled === true, pending = null, automatic = null, abort = null, disposed = false;
  let reconnectOrigins = [], reconnectAt = 0;
  const listeners = new Set();
  let status = { version: TILE_SAVE_PROTOTYPE_VERSION, controllerVersion: 'tile-save-controller-v9', configured: false, enabled, status: 'off', last: null, error: null, transport: null };
  const snapshot = () => ({ ...status, enabled, configured: Boolean(configuration) });
  const notify = () => { for (const listener of listeners) { try { listener(snapshot()); } catch {} } };
  const activity = (stage, data = {}) => { try { onActivity(`tile-save.${stage}`, data); } catch {} };

  async function capture() {
    const startedAt = Date.now();
    status = { ...status, status: 'saving', phase: 'checking', startedAt, elapsedMs: 0,
      progress: 0, transport: 'prototype', error: null, waitingFor: null, failedPhase: null };
    const localAbort = abort = new AbortController();
    let ui = null, state, session, city, originallyPaused, pausedBySave = false, lastNotifiedAt = 0;
    const sameContext = () => session != null && getState().gameSessionId === session && getState().cityCode === city;
    const progress = (value = {}) => {
      const phaseChanged = value.phase && value.phase !== status.phase;
      const now = Date.now();
      status = { ...status, ...value, elapsedMs: now - startedAt };
      if (phaseChanged || now - lastNotifiedAt >= 100) { ui?.progress(status); notify(); lastNotifiedAt = now; }
      if (phaseChanged) activity('phase', { phase: status.phase, elapsedMs: status.elapsedMs, bytes: status.progress });
    };
    const heartbeat = setInterval(() => progress(), 250);
    notify(); activity('start');
    try {
      if (disposed || !configuration || !isReady()) throw gateError('Tile save prototype is not ready');
      // A stopped writer must fail before freezing the game or generating a
      // large snapshot. Keep configuration so a restarted service can recover.
      const response = await fetchFn(new URL('/_prototype/save/status', configuration.origin), {
        method: 'POST', headers: configuration.token ? { 'X-PMTiles-Control-Token': configuration.token } : {},
        signal: AbortSignal.any([localAbort.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok || (await response.json()).version !== TILE_SAVE_PROTOTYPE_VERSION)
        throw new Error('Save writer is unavailable');
      localAbort.signal.throwIfAborted();
      if (disposed || !isReady()) throw gateError('World changed while checking the save writer');
      state = getState(); session = state.gameSessionId; city = state.cityCode;
      if (typeof state.setTimeConfig !== 'function' || !session || !city) throw gateError('Unsupported game state');
      originallyPaused = state.timeConfig.paused;
      ui = freezeUi(() => localAbort.abort());
      progress({ phase: 'settling' });
      state.setTimeConfig({ paused: true });
      pausedBySave = true;
      // Let the current native tick and UI updates settle before taking the
      // snapshot. Active routing/midnight work must settle for a stable upload.
      await yieldTask(); await yieldTask();
      // High-speed sessions recalculate almost continuously, so a single busy
      // sample would fail every save. Wait briefly for a quiet moment instead;
      // the game is already paused, so in-flight work drains without new input.
      // The wait is timed into the last-save breakdown so a slow session can
      // be told apart from a slow upload.
      const settleStarted = Date.now();
      const settleBy = settleStarted + Math.max(0, settleMs);
      let busy;
      while (sameContext() && isReady() && (busy = isBusy()) && Date.now() < settleBy) {
        localAbort.signal.throwIfAborted();
        const waitingFor = typeof busy === 'string' ? busy : null;
        if (waitingFor !== status.waitingFor) progress({ waitingFor });
        await yieldTask();
      }
      localAbort.signal.throwIfAborted();
      const settleWaitMs = Date.now() - settleStarted;
      if (!sameContext()) throw gateError('Tile changed while saving; partial save discarded');
      if (!isReady()) throw gateError('World not ready while saving; partial save discarded');
      if ((busy = isBusy())) throw gateError(typeof busy === 'string' ? busy : 'Game work is still changing the save');
      progress({ phase: 'generating', waitingFor: null });
      // Paint the phase before the native synchronous generator can block.
      await yieldTask(); await yieldTask();
      localAbort.signal.throwIfAborted();
      if (!sameContext() || !isReady() || isBusy()) throw gateError('Game state changed before snapshot generation');
      const stable = getState();
      const generated = performance.now();
      let save = await stable.generateSave({ name: nativeAutosaveName(), [STREAM_SAVE]: true });
      const generateMs = performance.now() - generated;
      if (save.version !== 4) throw new Error('Prototype supports native save schema 4 only');
      // Prototype uploads omit native journey-history rows: the demand model,
      // topology and trains stream untouched, and the live game is never
      // modified. Native saves keep the full history.
      const { save: slimmedSave, omittedJourneyRows } = slimExperimentalSaveDemand(save);
      save = slimmedSave;
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
          onProgress: value => { assertStable(); progress({ phase: value.phase ?? 'uploading', progress: value.bytes ?? status.progress }); },
        });
      } finally {
        references = null;
        save = null;
      }
      const durationMs = Date.now() - startedAt;
      status = { ...status, status: 'saved', phase: 'complete', transport: 'prototype', progress: result.bytes, elapsedMs: durationMs,
        last: { ...result, durationMs, transferDurationMs: result.durationMs, generateMs, settleMs: settleWaitMs, omittedJourneyRows, stabilitySummary } };
      activity('complete', { durationMs, bytes: result.bytes, generateMs }); notify();
      return result;
    } catch (error) {
      const cancelled = localAbort.signal.aborted;
      const unconfirmed = error.saveOutcome === 'unknown';
      status = { ...status, status: unconfirmed ? 'unconfirmed' : cancelled ? 'cancelled' : 'failed', failedPhase: status.phase,
        elapsedMs: Date.now() - startedAt, error: unconfirmed ? 'Save completion could not be confirmed. Check the save list before retrying. Native fallback is disabled.'
          : cancelled ? 'Autosave cancelled. No new save was written.'
          : `Autosave was not saved: ${error.message}. Native fallback is disabled.` };
      notify();
      if (!disposed) activity(cancelled && !unconfirmed ? 'cancelled' : 'error', { error: status.error, phase: status.phase, elapsedMs: status.elapsedMs });
      throw error;
    } finally {
      clearInterval(heartbeat); ui?.dispose(); abort = null;
      if (pausedBySave && sameContext() && !originallyPaused) getState().setTimeConfig({ paused: false });
    }
  }
  const run = () => {
    if (pending) return pending;
    pending = capture().finally(() => { pending = null; });
    return pending;
  };
  async function configureAutomatic({ origins = [], fetchFn = fetch, timeoutMs = 3000 } = {}) {
    // Background discovery: never throws, so startup and panel-open probes
    // can call it freely. Game-origin requests carry no token and survive
    // restarts. Remembers its origins for reconnect().
    if (origins.length) reconnectOrigins = origins;
    if (pending || disposed || configuration) return snapshot();
    for (const origin of origins) {
      let base;
      try {
        base = new URL(origin);
        if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') continue;
      } catch { continue; }
      try {
        const response = await fetchFn(new URL('/_prototype/save/status', base),
          { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) continue;
        if ((await response.json())?.version !== TILE_SAVE_PROTOTYPE_VERSION) continue;
        configuration = { origin: base.origin, token: null };
        status = { ...status, status: 'ready', error: null }; notify(); return snapshot();
      } catch { continue; }
    }
    return snapshot();
  }
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
      configuration = { origin: base.origin, token }; status.status = 'ready'; notify();       return snapshot();
    },
    reconnect({ fetchFn = fetch, timeoutMs = 3000 } = {}) {
      // Panel-open re-probe for a writer that started after the mod loaded.
      // Throttled: failed loopback probes log console errors. Never throws.
      if (pending || disposed || configuration || !reconnectOrigins.length) return Promise.resolve(snapshot());
      if (Date.now() - reconnectAt < 60000) return Promise.resolve(snapshot());
      reconnectAt = Date.now();
      return configureAutomatic({ origins: reconnectOrigins, fetchFn, timeoutMs });
    },
    setEnabled(value) {
      if (value && (!configuration || disposed)) throw new Error('Configure the prototype writer first');
      enabled = Boolean(value);
      onEnabledChange(enabled);
      if (enabled && !pending && status.transport === 'native') status = { ...status, status: 'ready', transport: null };
      notify(); return snapshot();
    },
    configureAutomatic,
    run,
    invoke(native) {
      if (disposed) return Promise.resolve({ status: 'cancelled', saved: false });
      if (!enabled) {
        status = { ...status, status: 'native', transport: 'native', error: null }; notify();
        activity('native', { reason: 'Experimental autosaves are disabled' });
        return native();
      }
      if (automatic) return automatic;
      // Failure is visible and leaves the transport armed for the next attempt.
      // Never start a second, native save or silently change future autosaves.
      automatic = run().catch(() => ({ status: status.status, saved: false, error: status.error }))
        .finally(() => { automatic = null; });
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
  const button = document.createElement('button'); button.textContent = 'Cancel save';
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
    progress: value => { message.textContent = prototypeSaveProgressText(value); },
    dispose() { for (const event of events) window.removeEventListener(event, block, true); panel.remove(); if (previousFocus?.isConnected) previousFocus.focus?.(); },
  };
}
