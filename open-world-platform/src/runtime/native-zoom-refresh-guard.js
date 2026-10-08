const GUARD = '__openWorldNativeZoomRefreshGuard__';
export const NATIVE_ZOOM_REFRESH_VERSION = 'native-zoom-refresh-v1';

function isNativeZoomCallback(callback) {
  if (typeof callback !== 'function') return false;
  const source = Function.prototype.toString.call(callback);
  return source.includes('.target.getZoom()') && source.includes('lastZoomUpdateRef.current')
    && source.includes('setZoomInStore(') && source.includes('debouncedZoom(');
}

function readUiQueue(queue) {
  // A React state queue contains a dispatch bound to its fiber. Keep a weak
  // reference so discovery cannot pin the provider's entire old component tree.
  const ref = new WeakRef(queue);
  return () => {
    const state = ref.deref()?.lastRenderedState;
    return state?.userActionOverride ?? state?.userAction ?? null;
  };
}

function findUiReader(fiber) {
  if (typeof WeakRef !== 'function') return null;
  for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i < 200; i++, hook = hook.next) {
      const state = hook.queue?.lastRenderedState;
      if (typeof state?.userAction === 'string' && Object.hasOwn(state, 'userActionOverride')) {
        return readUiQueue(hook.queue);
      }
    }
  }
  return null;
}

// The public API exposes the MapLibre camera, but not its React zoom callback
// or editing state. Recognize the mounted integration by shape and behavior;
// unknown game builds keep native behavior. Never retain a discovered fiber.
export function findNativeZoomBinding(map, document = globalThis.document) {
  if (!map) return null;
  const root = document?.getElementById?.('root');
  const seen = new Set();
  for (const key of Object.keys(root ?? {})) {
    if (!key.startsWith('__reactContainer$')) continue;
    const container = root[key], stack = [container?.stateNode?.current ?? container?.current ?? container];
    while (stack.length && seen.size < 5000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      let hook = fiber.memoizedState;
      for (let i = 0; hook && i < 200; i++, hook = hook.next) {
        const owner = hook.memoizedState;
        if (owner?._map !== map || typeof owner.setProps !== 'function') continue;
        if (!owner[GUARD]?.installed && !isNativeZoomCallback(owner.props?.onZoom)) continue;
        const readUserAction = findUiReader(fiber);
        if (readUserAction) return { owner, readUserAction };
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }
  return null;
}

/** Keep native marker/layer data visible while MapLibre and Deck move their
 * camera continuously. Publish one native zoom notification after the gesture
 * settles, using React's latest callback. This also delays other native detail
 * changes driven by that zoom value; editing and immediate jumps stay native. */
export function installNativeZoomRefreshGuard({ owner, map = owner?._map,
  readUserAction = () => null, getIdentity = () => 'current', quietMs = 250,
  now = () => performance.now(), setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis) } = {}) {
  owner?.[GUARD]?.dispose();
  let descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'props');
  if (!map || owner?._map !== map || !descriptor?.configurable || !descriptor.writable
    || !isNativeZoomCallback(descriptor.value?.onZoom) || !setTimeoutFn || !clearTimeoutFn) {
    return { installed: false, version: NATIVE_ZOOM_REFRESH_VERSION, dispose() {},
      snapshot: () => ({ installed: false, version: NATIVE_ZOOM_REFRESH_VERSION, reason: 'native-binding-unavailable' }) };
  }
  let props = descriptor.value, native = props.onZoom, pending = null, timer = null, disposed = false, enabled = true;
  // Retaining descriptor.value here would pin the first React props/children
  // and callback's captured network, even after React publishes replacements.
  descriptor = { configurable: descriptor.configurable, enumerable: descriptor.enumerable, writable: descriptor.writable };
  const emptyStats = () => ({ received: 0, deferred: 0, refreshed: 0, bypassed: 0, cancelled: 0,
    lastRefreshZoom: null, lastRefreshAt: null });
  const stats = emptyStats();
  const identity = () => { try { return getIdentity(); } catch { return null; } };
  const canDefer = () => {
    try {
      return enabled && readUserAction() === 'none' && props.dragPan !== false
        && (props.cursor == null || props.cursor === 'default');
    } catch { return false; }
  };
  const clearTimer = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  const cancel = () => { clearTimer(); if (pending) stats.cancelled++; pending = null; };
  const arm = delay => { clearTimer(); timer = setTimeoutFn(run, delay); };
  function run() {
    timer = null;
    if (!pending || disposed) return;
    if (map._removed || identity() !== pending.identity) { cancel(); return; }
    if (canDefer() && map.isZooming?.()) { arm(100); return; }
    const work = pending;
    pending = null;
    stats.refreshed++;
    stats.lastRefreshZoom = map.getZoom?.() ?? null;
    stats.lastRefreshAt = now();
    return native.apply(work.receiver, work.args);
  }
  function wrapper(...args) {
    if (disposed) return native.apply(this, args);
    stats.received++;
    const currentIdentity = identity();
    if (args[0]?.target !== map || currentIdentity == null || !canDefer() || !map.isZooming?.()) {
      cancel(); stats.bypassed++;
      return native.apply(this, args);
    }
    if (pending && pending.identity !== currentIdentity) cancel();
    pending = { receiver: this, args, identity: currentIdentity };
    stats.deferred++;
    arm(quietMs);
  }
  const getter = () => props;
  const setter = value => {
    if (value?.onZoom !== wrapper) {
      if (!isNativeZoomCallback(value?.onZoom)) {
        // A foreign wrapper may call our old wrapper. Restore its props, while
        // the disposed wrapper still delegates to the last recognized native
        // callback instead of recursing through that foreign function.
        props = value;
        controller.dispose();
        return;
      }
      native = value.onZoom;
    }
    props = { ...value, onZoom: wrapper };
    if (pending && !canDefer()) arm(0);
  };
  const onZoomEnd = () => { if (pending) arm(quietMs); };
  const onRemove = () => controller.dispose();
  props = { ...props, onZoom: wrapper };
  Object.defineProperty(owner, 'props', { configurable: true, enumerable: descriptor.enumerable, get: getter, set: setter });
  const controller = { installed: true, version: NATIVE_ZOOM_REFRESH_VERSION,
    snapshot: () => ({ ...stats, installed: !disposed, enabled: enabled && !disposed, pending: Boolean(pending),
      quietMs, version: NATIVE_ZOOM_REFRESH_VERSION }),
    reset: () => Object.assign(stats, emptyStats()),
    setEnabled(value) {
      if (disposed) return;
      enabled = Boolean(value);
      if (!enabled && pending) { clearTimer(); run(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; controller.installed = false; cancel();
      map.off?.('zoomend', onZoomEnd); map.off?.('remove', onRemove);
      if (Object.getOwnPropertyDescriptor(owner, 'props')?.get === getter) {
        Object.defineProperty(owner, 'props', { ...descriptor,
          value: props?.onZoom === wrapper ? { ...props, onZoom: native } : props });
      }
      if (owner[GUARD] === controller) delete owner[GUARD];
    } };
  Object.defineProperty(owner, GUARD, { configurable: true, value: controller });
  map.on?.('zoomend', onZoomEnd); map.on?.('remove', onRemove);
  return controller;
}
