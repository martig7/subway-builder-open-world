import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findNativeZoomBinding, installNativeZoomRefreshGuard, NATIVE_ZOOM_REFRESH_VERSION } from '../src/runtime/native-zoom-refresh-guard.js';

function nativeCallback(record) {
  const lastZoomUpdateRef = { current: 0 };
  const setZoom = () => {}, setZoomInStore = () => {}, debouncedZoom = () => {};
  return function nativeZoom(event, ...args) {
    const newZoom = event.target.getZoom();
    if (Math.abs(newZoom - lastZoomUpdateRef.current) >= 1) {
      lastZoomUpdateRef.current = newZoom;
      setZoom(newZoom); setZoomInStore(newZoom);
    } else debouncedZoom(newZoom);
    return record({ zoom: newZoom, event, args, receiver: this });
  };
}

function fixture() {
  let time = 0, identity = 'session:tile', userAction = 'none';
  let nextTimer = 0;
  const timers = new Map(), listeners = new Map(), calls = [];
  const map = { zoom: 14, zooming: true, isZooming() { return this.zooming; }, getZoom() { return this.zoom; },
    on(type, fn) { const list = listeners.get(type) ?? new Set(); list.add(fn); listeners.set(type, list); },
    off(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, target: this }); } };
  const owner = { _map: map, props: { onZoom: nativeCallback(v => { calls.push({ name: 'first', ...v }); return 'native-result'; }),
    cursor: undefined, stationDots: true, stationLabels: true, children: [] }, setProps(props) { this.props = props; } };
  const options = { owner, map, readUserAction: () => userAction, getIdentity: () => identity, now: () => time,
    quietMs: 250, setTimeoutFn(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); } };
  const guard = installNativeZoomRefreshGuard(options);
  return { map, owner, guard, options, timers, listeners, calls,
    emit(extra = {}) { return owner.props.onZoom({ type: 'zoom', target: map, ...extra }); },
    setIdentity(value) { identity = value; }, setAction(value) { userAction = value; },
    tick(ms) { time += ms; const due = [...timers].filter(([, t]) => t.at <= time); for (const [id, t] of due) { timers.delete(id); t.fn(); } } };
}

test('zoom gestures retain visible layer props and coalesce native rebuild notifications until quiet', () => {
  const f = fixture(), children = f.owner.props.children;
  for (let i = 0; i < 42; i++) { f.map.zoom += .01; f.emit(); }
  assert.equal(f.calls.length, 0, 'native marker rebuild notifications ran during zoom');
  assert.equal(f.timers.size, 1);
  assert.equal(f.owner.props.stationDots, true); assert.equal(f.owner.props.stationLabels, true);
  assert.equal(f.owner.props.children, children);
  f.tick(300); assert.equal(f.calls.length, 0, 'quiet timer cannot flush an active gesture');
  f.map.zooming = false; f.map.fire('zoomend'); f.tick(249);
  assert.equal(f.calls.length, 0);
  f.tick(1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].zoom, f.map.zoom);
  assert.equal(f.guard.snapshot().pending, false); assert.equal(f.timers.size, 0);
  f.guard.dispose();
});

test('rapid gestures share one pending event and a missing zoomend still refreshes', () => {
  const f = fixture(); f.emit(); f.map.zooming = false; f.map.fire('zoomend'); f.tick(150);
  f.map.zooming = true; f.map.zoom = 15.123456; f.emit(); f.tick(300);
  assert.equal(f.calls.length, 0);
  f.map.zooming = false; f.tick(100);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].zoom, 15.123456);
  f.guard.dispose();
});

test('React callback replacement uses current closures and preserves other camera events', () => {
  const f = fixture(), firstEvent = { type: 'zoom', target: f.map }, lastEvent = { type: 'zoom', target: f.map };
  const receiver = {}, extra = { native: 'argument' }, onMove = () => 'move-result';
  f.owner.props.onZoom(firstEvent);
  const latest = nativeCallback(v => { f.calls.push({ name: 'latest', ...v }); });
  f.owner.setProps({ ...f.owner.props, onZoom: latest, onMove });
  f.owner.props.onZoom.call(receiver, lastEvent, extra);
  f.map.zoom = 16.7654321; f.map.zooming = false; f.tick(250);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'latest');
  assert.equal(f.calls[0].event, lastEvent); assert.equal(f.calls[0].receiver, receiver);
  assert.deepEqual(f.calls[0].args, [extra]); assert.equal(f.calls[0].zoom, 16.7654321);
  assert.equal(f.owner.props.onMove(), 'move-result');
  f.guard.dispose(); assert.equal(f.owner.props.onZoom, latest);
});

test('editing, annotations, unknown UI state and immediate camera jumps use native behavior', () => {
  const f = fixture(); f.map.zooming = false;
  assert.equal(f.emit(), 'native-result'); assert.equal(f.calls.length, 1);
  f.map.zooming = true;
  for (const action of ['draw-line-track', 'reshape-track', 'delete-track-group', 'draw-fare-zone', null]) {
    f.setAction(action); f.emit();
  }
  assert.equal(f.calls.length, 6);
  f.setAction('none'); f.owner.setProps({ ...f.owner.props, cursor: 'crosshair' }); f.emit();
  f.owner.setProps({ ...f.owner.props, cursor: undefined, dragPan: false }); f.emit();
  assert.equal(f.calls.length, 8); assert.equal(f.timers.size, 0);
  f.guard.dispose();
});

test('entering editing cancels the quiet delay and cannot replay an older event after a bypass', () => {
  const f = fixture(); f.emit({ old: true }); f.setAction('reshape-track');
  f.owner.setProps({ ...f.owner.props }); f.tick(0);
  assert.equal(f.calls.length, 1);
  f.setAction('none'); f.emit(); f.map.zooming = false; f.emit({ latest: true }); f.tick(1000);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].event.latest, true);
  assert.equal(f.timers.size, 0); f.guard.dispose();
});

test('map removal and session changes cancel pending work and detach listeners', () => {
  const f = fixture(); f.emit(); f.setIdentity('other-session'); f.map.zooming = false; f.tick(250);
  assert.equal(f.calls.length, 0); assert.equal(f.guard.snapshot().pending, false);
  f.map.zooming = true; f.emit(); f.map._removed = true; f.map.fire('remove'); f.tick(1000);
  assert.equal(f.calls.length, 0); assert.equal(f.guard.snapshot().installed, false);
  assert.equal(f.listeners.get('zoomend').size, 0); assert.equal(f.listeners.get('remove').size, 0);
  assert.equal(f.timers.size, 0);
});

test('temporary diagnostic bypass publishes pending zoom and restores native updates', () => {
  const f = fixture(); f.emit(); f.guard.setEnabled(false);
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.guard.snapshot().enabled, false); f.emit(); assert.equal(f.calls.length, 2);
  f.guard.setEnabled(true); f.emit(); assert.equal(f.calls.length, 2);
  f.map.zooming = false; f.tick(250); assert.equal(f.calls.length, 3);
  f.guard.reset(); assert.equal(f.guard.snapshot().received, 0); f.guard.dispose();
});

test('hot attachment replaces the old generation and wrapper and restores latest native props', () => {
  const f = fixture(), oldWrapper = f.owner.props.onZoom, oldGetter = Object.getOwnPropertyDescriptor(f.owner, 'props').get;
  f.guard.version = 'native-zoom-refresh-v0'; f.emit();
  const next = installNativeZoomRefreshGuard(f.options);
  assert.notEqual(next, f.guard); assert.notEqual(f.owner.props.onZoom, oldWrapper);
  assert.notEqual(Object.getOwnPropertyDescriptor(f.owner, 'props').get, oldGetter);
  assert.equal(next.version, NATIVE_ZOOM_REFRESH_VERSION); assert.equal(f.guard.snapshot().installed, false);
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.get('zoomend').size, 1);
  f.emit(); f.map.zooming = false; f.tick(250); assert.equal(f.calls.length, 1);
  next.dispose(); assert.equal(typeof Object.getOwnPropertyDescriptor(f.owner, 'props').value.onZoom, 'function');
  next.dispose(); assert.equal(f.listeners.get('zoomend').size, 0);
});

test('unsupported callbacks and property accessors remain native and foreign wrappers do not recurse', () => {
  const f = fixture(), wrapped = f.owner.props.onZoom;
  const foreign = function (...args) { return wrapped.apply(this, args); };
  f.owner.setProps({ onZoom: foreign });
  assert.equal(f.guard.snapshot().installed, false); assert.equal(f.owner.props.onZoom, foreign);
  assert.equal(f.emit(), 'native-result'); assert.equal(f.calls.length, 1);
  const unsupported = { _map: f.map, props: { onZoom() {} } };
  assert.equal(installNativeZoomRefreshGuard({ owner: unsupported }).installed, false);
  const props = f.owner.props;
  Object.defineProperty(f.owner, 'props', { configurable: true, get: () => props });
  assert.equal(installNativeZoomRefreshGuard(f.options).installed, false);
});

test('native discovery finds this map and reads effective editing state without retaining its React tree', () => {
  const f = fixture(); f.guard.dispose();
  const ui = { userAction: 'none', userActionOverride: null }, queue = { lastRenderedState: ui };
  const parent = { memoizedState: { memoizedState: ui, queue } };
  const fiber = { return: parent, memoizedState: { memoizedState: f.owner } }; parent.child = fiber;
  const root = { '__reactContainer$test': { stateNode: { current: parent } } };
  const doc = { getElementById: () => root };
  const binding = findNativeZoomBinding(f.map, doc);
  assert.equal(binding.owner, f.owner); assert.equal(binding.readUserAction(), 'none');
  queue.lastRenderedState = { userAction: 'none', userActionOverride: 'reshape-track' };
  assert.equal(binding.readUserAction(), 'reshape-track');
  assert.equal(findNativeZoomBinding({}, doc), null);
  f.owner.props = { onZoom() {} };
  assert.equal(findNativeZoomBinding(f.map, doc), null);
});

test('callback replacement releases obsolete React props and pending event payloads', () => {
  const moduleUrl = new URL('../src/runtime/native-zoom-refresh-guard.js', import.meta.url).href;
  execFileSync(process.execPath, ['--max-old-space-size=128', '--expose-gc', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { installNativeZoomRefreshGuard, findNativeZoomBinding } from ${JSON.stringify(moduleUrl)};
    const nativeCallback = ${nativeCallback.toString()};
    const map = { isZooming: () => true, getZoom: () => 14, on() {}, off() {} };
    const replacement = nativeCallback(() => 42);
    const setTimeoutFn = () => 1, clearTimeoutFn = () => {};
    const setProps = function (props) { this.props = props; };
    function fixture() {
      const payload = new Array(1000).fill(17), native = nativeCallback(() => payload.length);
      const initialProps = { onZoom: native, children: payload };
      const ui = { userAction: 'none', userActionOverride: null }, queue = { lastRenderedState: ui };
      const parent = { memoizedState: { memoizedState: ui, queue } };
      const owner = { _map: map, props: initialProps, setProps };
      parent.child = { return: parent, memoizedState: { memoizedState: owner } };
      const root = { '__reactContainer$test': { stateNode: { current: parent } } };
      const binding = findNativeZoomBinding(map, { getElementById: () => root });
      const guard = installNativeZoomRefreshGuard({ ...binding, map, setTimeoutFn, clearTimeoutFn });
      const refs = [payload, native, initialProps, queue, parent].map(v => new WeakRef(v));
      owner.props = { onZoom: replacement, children: [] };
      const eventPayload = new Array(1000).fill(19), eventRef = new WeakRef(eventPayload);
      owner.props.onZoom({ target: map, payload: eventPayload });
      owner.props.onZoom({ target: map });
      return { owner, guard, refs: [...refs, eventRef], reader: binding.readUserAction };
    }
    const current = fixture();
    for (let i = 0; i < 8; i++) { await setImmediate(); globalThis.gc(); }
    assert.equal(current.guard.installed, true);
    for (const ref of current.refs) assert.equal(ref.deref() === undefined, true, 'obsolete props, callback, UI tree or event retained');
    assert.equal(current.reader(), null);
    current.guard.dispose();
  `], { stdio: 'pipe', timeout: 15000 });
});
