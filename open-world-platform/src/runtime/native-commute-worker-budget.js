export const NATIVE_COMMUTE_WORKER_BUDGET_VERSION = 'native-commute-worker-budget-v2';
const KEY = '__openWorldNativeCommuteWorkerBudget__';
// Protocol verified against Subway Builder 1.7. Unknown builds pass through.
const SCRIPT = 'popCommuteWorker.worker-CI81Zuw7.js';

/** Preserve the game's logical pool and original routing code while bounding
 * physical network replicas. The verified protocol has one terminal response
 * per batch; setNetwork has no response. No in-flight task is retired to resize. */
export function installNativeCommuteWorkerBudget({ root = globalThis, now = () => Date.now() } = {}) {
  const previous = root[KEY];
  if (previous?.version === NATIVE_COMMUTE_WORKER_BUDGET_VERSION && root.Worker === previous.wrapper) return previous;
  previous?.restoreConstructor?.();
  const Original = root.Worker;
  if (typeof Original !== 'function' || typeof root.EventTarget !== 'function' || typeof root.structuredClone !== 'function') return null;
  const slots = new Set(), queue = [], networks = new WeakMap();
  const maxWorkers = Math.min(6, Math.max(1, root.navigator?.hardwareConcurrency ?? 6));
  let memory = null, idleTimer = null, scheduled = false, scriptUrl = null;
  const stats = { logicalWorkers: 0, created: 0, retired: 0, completed: 0, cancelled: 0, networkClones: 0, peakBusy: 0 };
  const busy = () => [...slots].filter(slot => slot.job != null).length;
  const limit = () => {
    if (memory && now() >= memory.at && now() - memory.at <= 3000) {
      if ((memory.allocated != null && memory.allocated >= 3.25 * 1024 ** 3)
        || (memory.headroom != null && memory.headroom < 512 * 1024 ** 2)) return 1;
      if (memory.allocated != null && memory.allocated >= 3 * 1024 ** 3) return Math.min(2, maxWorkers);
    }
    return maxWorkers;
  };
  const cancelIdle = () => { if (idleTimer != null) root.clearTimeout(idleTimer); idleTimer = null; };
  const retire = slot => { slot.worker.terminate(); slots.delete(slot); stats.retired++; };
  const armIdle = () => {
    if (queue.length || busy() || !slots.size) { cancelIdle(); return; }
    if (idleTimer == null) idleTimer = root.setTimeout(() => {
      idleTimer = null;
      if (!queue.length && !busy()) for (const slot of [...slots]) retire(slot);
    }, 5000);
  };
  const emit = (face, type, value) => {
    if (face.closed) return;
    const event = type === 'message' ? new root.MessageEvent('message', { data: value })
      : Object.assign(new root.Event('error'), { message: String(value?.message ?? value) });
    face.dispatchEvent(event);
    face[`on${type}`]?.call(face, event);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; drain(); });
  };
  const complete = (slot, type, value) => {
    if (!slots.has(slot)) return;
    const job = slot.job;
    slot.job = null;
    if (type === 'error') retire(slot);
    if (job) {
      stats.completed++;
      try { emit(job.face, type, value); } finally { schedule(); }
    }
  };
  const createSlot = job => {
    const worker = new Original(job.face.url, { ...job.face.options, name: NATIVE_COMMUTE_WORKER_BUDGET_VERSION });
    const slot = { worker, job: null, network: null };
    worker.onmessage = event => complete(slot, 'message', event.data);
    worker.onerror = error => complete(slot, 'error', error);
    worker.onmessageerror = () => complete(slot, 'error', new Error('Native commute worker response could not be decoded'));
    slots.add(slot); stats.created++;
    return slot;
  };
  function drain() {
    const capacity = limit();
    for (const slot of [...slots]) if (!slot.job && slots.size > capacity) retire(slot);
    while (queue.length && busy() < capacity) {
      const job = queue.shift();
      if (job.face.closed) continue;
      let slot;
      try {
        slot = [...slots].find(candidate => !candidate.job) ?? createSlot(job);
        slot.job = job;
        stats.peakBusy = Math.max(stats.peakBusy, busy());
        if (job.network && slot.network !== job.network) {
          slot.worker.postMessage({ setNetwork: job.network });
          slot.network = job.network;
        }
        slot.worker.postMessage(job.data);
      } catch (error) {
        if (slot) complete(slot, 'error', error);
        else emit(job.face, 'error', error);
      }
    }
    armIdle();
  }
  class LogicalWorker extends root.EventTarget {
    constructor(url, options) {
      super(); this.url = url; this.options = { ...options }; this.network = null; this.closed = false;
      this.onmessage = null; this.onerror = null; stats.logicalWorkers++;
    }
    postMessage(data, options) {
      if (this.closed) return;
      cancelIdle();
      if (data?.setNetwork && typeof data.setNetwork === 'object') {
        let network = networks.get(data.setNetwork);
        if (!network) { network = root.structuredClone(data.setNetwork); networks.set(data.setNetwork, network); stats.networkClones++; }
        this.network = network;
        return;
      }
      const transfer = Array.isArray(options) ? options : options?.transfer;
      const copy = root.structuredClone(data, transfer ? { transfer } : undefined);
      if (!this.network && !copy?.network) {
        queueMicrotask(() => emit(this, 'message', { batchError: 'Native commute batch has no routing network' }));
        return;
      }
      queue.push({ face: this, network: this.network, data: copy });
      schedule();
    }
    terminate() {
      if (this.closed) return;
      this.closed = true; this.network = null; stats.cancelled++;
      for (let index = queue.length - 1; index >= 0; index--) if (queue[index].face === this) queue.splice(index, 1);
      for (const slot of [...slots]) if (slot.job?.face === this) retire(slot);
      schedule();
    }
  }
  const wrapper = new Proxy(Original, { construct(target, args, newTarget) {
    let url;
    try { url = new URL(String(args[0]), root.location?.href); } catch {}
    if (!['file:', 'app:'].includes(url?.protocol) || url.pathname.split('/').at(-1) !== SCRIPT || args[1]?.type !== 'module'
      || (scriptUrl != null && scriptUrl !== url.href)) return Reflect.construct(target, args, newTarget);
    scriptUrl = url.href;
    return new LogicalWorker(args[0], args[1]);
  } });
  const controller = {
    version: NATIVE_COMMUTE_WORKER_BUDGET_VERSION, original: Original, wrapper,
    updateMemory(sample) {
      memory = sample ? { at: sample.at, allocated: sample.workersAvailable ? sample.allIsolatesAllocatedBytes : null,
        headroom: sample.available ? sample.headroomBytes : null } : null;
      schedule();
    },
    snapshot: () => ({ version: NATIVE_COMMUTE_WORKER_BUDGET_VERSION, ...stats,
      workers: slots.size, busy: busy(), queued: queue.length, limit: limit() }),
    restoreConstructor() { if (root.Worker === wrapper) root.Worker = Original; },
  };
  root.Worker = wrapper;
  root[KEY] = controller;
  return controller;
}
