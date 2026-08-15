/** Coalesce a burst of native edits into one authoritative projection commit. */
export function createNetworkProjectionReconciler({
  runtime,
  onRejected = () => {},
  delayMs = 120,
  isReady = () => true,
  isActive = () => true,
}) {
  let timer = null;
  let running = false;
  let queuedReason = null;
  let cancelled = false;
  let lastRejectedSignature = null;

  const flush = async () => {
    timer = null;
    if (cancelled || !isActive()) {
      queuedReason = null;
      return;
    }
    if (running || !queuedReason) return;
    if (!isReady()) {
      timer = setTimeout(flush, delayMs);
      return;
    }
    const reason = queuedReason;
    queuedReason = null;
    running = true;
    try {
      const result = await runtime.reconcileActiveProjection(reason);
      if (result?.status === 'rejected') {
        const signature = JSON.stringify([
          result.warning?.code,
          result.warning?.affectedObjectIds ?? [],
          result.warning?.suggestedTileIds ?? [],
        ]);
        if (signature !== lastRejectedSignature) onRejected(result.warning, result);
        lastRejectedSignature = signature;
      } else lastRejectedSignature = null;
    } catch (error) {
      if (!isActive()) {
        queuedReason = null;
      } else if (!isReady() || /boot must complete first/i.test(error?.message ?? '')) {
        queuedReason ??= reason;
      } else throw error;
    } finally {
      running = false;
      if (queuedReason && !cancelled) timer = setTimeout(flush, delayMs);
    }
  };

  return {
    queue(reason = 'network-change') {
      if (cancelled || !isActive()) return;
      queuedReason = reason;
      if (!running) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, delayMs);
      }
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
    cancel() {
      cancelled = true;
      queuedReason = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Coalesce native schedule-button bursts without diffing unrelated route fields. */
export function createRouteScheduleReconciler({
  runtime,
  onRejected = () => {},
  delayMs = 120,
  isReady = () => true,
  isActive = () => true,
}) {
  let timer = null;
  let running = false;
  let cancelled = false;
  const pending = new Map();

  const flush = async () => {
    timer = null;
    if (cancelled || !isActive()) {
      pending.clear();
      return;
    }
    if (running || pending.size === 0) return;
    if (!isReady()) {
      timer = setTimeout(flush, delayMs);
      return;
    }
    const changes = [...pending.values()];
    pending.clear();
    running = true;
    try {
      const result = await runtime.reconcileActiveScheduleChanges(changes);
      if (result?.status === 'rejected') onRejected(result.warning, result);
    } catch (error) {
      if (!isActive()) pending.clear();
      else if (!isReady() || /boot must complete first/i.test(error?.message ?? '')) {
        for (const change of changes) pending.set(change.routeId, change);
      } else throw error;
    } finally {
      running = false;
      if (pending.size > 0 && !cancelled && isActive()) timer = setTimeout(flush, delayMs);
    }
  };

  return {
    queue(routeId, schedule, previousSchedule = null) {
      if (cancelled || !isActive() || routeId == null || !schedule) return;
      pending.set(String(routeId), {
        routeId: String(routeId),
        schedule: structuredClone(schedule),
        previousSchedule: previousSchedule ? structuredClone(previousSchedule) : null,
      });
      if (!running) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, delayMs);
      }
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
    cancel() {
      cancelled = true;
      pending.clear();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function trackIdSignature(ids) {
  return JSON.stringify([...new Set(ids ?? [])].map(String).sort());
}

function inventorySignatures(inventory) {
  return {
    constructed: trackIdSignature(inventory?.constructedTrackIds),
    blueprint: trackIdSignature(inventory?.blueprintTrackIds),
  };
}

/**
 * Capture constructed network changes. Subway Builder's onTrackChange hook
 * also fires for blueprint additions/deletions, so compare the constructed
 * inventory and use onTrackBuilt for the blueprint-to-constructed transition.
 */
export function registerNetworkProjectionHooks(
  hooks,
  changed,
  scheduleChanged = null,
  { readConstructedTrackIds = null, readTrackInventory = null } = {},
) {
  const readInventory = readTrackInventory ?? (readConstructedTrackIds
    ? () => ({ constructedTrackIds: readConstructedTrackIds(), blueprintTrackIds: [] })
    : null);
  let trackInventory = readInventory ? inventorySignatures(readInventory()) : null;
  let blueprintTrackChangePending = false;
  const refreshConstructedTracks = () => {
    if (!readInventory) return null;
    const next = inventorySignatures(readInventory());
    const change = {
      constructed: next.constructed !== trackInventory.constructed,
      blueprint: next.blueprint !== trackInventory.blueprint,
    };
    trackInventory = next;
    return change;
  };
  const unsubscribers = [
    hooks?.onBlueprintPlaced?.(() => {
      blueprintTrackChangePending = true;
    }),
    hooks?.onTrackChange?.((action) => {
      const inventoryChanged = refreshConstructedTracks();
      const blueprintOnly = inventoryChanged?.blueprint === true
        || inventoryChanged?.constructed === false
        || (inventoryChanged == null && blueprintTrackChangePending && action === 'add');
      blueprintTrackChangePending = false;
      if (!blueprintOnly) changed('track-change');
    }),
    hooks?.onTrackBuilt?.(() => {
      blueprintTrackChangePending = false;
      refreshConstructedTracks();
      changed('track-built');
    }),
    hooks?.onStationBuilt?.(() => changed('station-built')),
    hooks?.onStationDeleted?.(() => changed('station-deleted')),
    hooks?.onRouteCreated?.(() => changed('route-created')),
    hooks?.onRouteDeleted?.(() => changed('route-deleted')),
    hooks?.onScheduleChange?.((routeId, schedule, previousSchedule) => {
      if (scheduleChanged) scheduleChanged(routeId, schedule, previousSchedule);
      else changed('schedule-change');
    }),
  ];
  return () => { for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe(); };
}
