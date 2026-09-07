const GUARD = '__openWorldAutosaveIdleGuard__';
export const NATIVE_AUTOSAVE_IDLE_VERSION = 'native-autosave-idle-v2';

// The game exposes no autosave scheduling API. Recognize its mounted callback
// by behavior, without importing a version-specific hashed bundle. If its shape
// changes, leave native autosaving intact.
export function findNativeAutosaveRef(document = globalThis.document) {
  const root = document?.getElementById?.('root');
  for (const key of Object.keys(root ?? {})) {
    if (!key.startsWith('__reactContainer$')) continue;
    const container = root[key];
    const stack = [container?.stateNode?.current ?? container?.current ?? container];
    const seen = new Set();
    while (stack.length && seen.size < 5000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      if (fiber.type?.name === 'AutosaveManager') {
        let hook = fiber.memoizedState;
        for (let i = 0; hook && i < 200; i++, hook = hook.next) {
          const ref = hook.memoizedState;
          if (ref?.[GUARD]) return ref;
          if (typeof ref?.current !== 'function') continue;
          const source = Function.prototype.toString.call(ref.current);
          if (source.includes('[Autosave] performAutosaveCallback called')
            && source.includes('validateSaveData') && source.includes('markAutosaveStart')) return ref;
        }
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }
  return null;
}

/** Defer the entire native autosave callback, before it creates a snapshot.
 * React can replace the callback while queued; the accessor always uses the
 * latest one. The native interval, save format, retry logic and UI remain owned
 * by the base game. */
export function installNativeAutosaveIdleGuard({ ref, isMoving = () => false,
  getIdentity = () => 'current', now = () => performance.now(), quietMs = 1500,
  maxDelayMs = 30000, setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis) } = {}) {
  ref?.[GUARD]?.dispose();
  const descriptor = ref && Object.getOwnPropertyDescriptor(ref, 'current');
  if (!descriptor?.configurable || typeof descriptor.value !== 'function') {
    return { installed: false, dispose() {}, snapshot: () => ({ installed: false }) };
  }
  let native = descriptor.value, pending = null, timer = null, disposed = false;
  let lastMovement = -Infinity;
  const stats = { deferred: 0, idleSaves: 0, deadlineSaves: 0, cancelled: 0 };
  const cancel = () => {
    if (timer !== null) clearTimeoutFn?.(timer);
    timer = null;
    const work = pending;
    pending = null;
    if (work) { stats.cancelled++; work.resolve(); }
  };
  const run = () => {
    timer = null;
    if (!pending) return;
    if (disposed || getIdentity() !== pending.identity) { cancel(); return; }
    const time = now(), moving = isMoving();
    if (moving) lastMovement = time;
    const deadline = time - pending.started >= maxDelayMs;
    if (!deadline && (moving || time - lastMovement < quietMs)) {
      timer = setTimeoutFn(run, Math.min(100, maxDelayMs - (time - pending.started)));
      return;
    }
    const work = pending;
    pending = null;
    stats[deadline ? 'deadlineSaves' : 'idleSaves']++;
    try { Promise.resolve(native.apply(work.receiver, work.args)).then(work.resolve, work.reject); }
    catch (error) { work.reject(error); }
  };
  function wrapper(...args) {
    if (pending) return pending.promise;
    const time = now();
    if (isMoving()) lastMovement = time;
    if (disposed || time - lastMovement >= quietMs) return native.apply(this, args);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending = { promise, resolve, reject, args, receiver: this, started: time, identity: getIdentity() };
    stats.deferred++;
    timer = setTimeoutFn(run, 100);
    return promise;
  }
  const getter = () => wrapper;
  Object.defineProperty(ref, 'current', { configurable: true, enumerable: descriptor.enumerable,
    get: getter, set: value => { native = value; } });
  const controller = { installed: true, version: NATIVE_AUTOSAVE_IDLE_VERSION,
    noteMovement: () => { lastMovement = now(); },
    snapshot: () => ({ ...stats, pending: Boolean(pending), version: NATIVE_AUTOSAVE_IDLE_VERSION }),
    dispose() {
      if (disposed) return;
      disposed = true; cancel();
      if (Object.getOwnPropertyDescriptor(ref, 'current')?.get === getter) {
        Object.defineProperty(ref, 'current', { ...descriptor, value: native });
      }
      if (ref[GUARD] === controller) delete ref[GUARD];
    } };
  Object.defineProperty(ref, GUARD, { configurable: true, value: controller });
  return controller;
}
