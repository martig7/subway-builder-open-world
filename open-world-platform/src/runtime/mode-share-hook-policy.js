export const STRUCTURAL_NETWORK_HOOKS = Object.freeze([
  'onScheduleChange',
]);

export const FARE_HOOKS = Object.freeze([
  'onTicketPriceChanged', 'onFareGroupsChanged',
]);

/**
 * Register only public schedule/fare invalidations. Store-action observation
 * classifies committed route-stop changes; route creation/deletion hooks are
 * too broad because blank route design does not change passenger service.
 */
export function registerModeShareInvalidationHooks(hooks, { scheduleChanged, fareChanged }) {
  hooks?.onScheduleChange?.(scheduleChanged);
  for (const hookName of FARE_HOOKS) hooks?.[hookName]?.(fareChanged);
}

/**
 * Service edits only mark mode share stale. The day-change hook consumes that
 * flag once at midnight, keeping statewide pathfinding entirely off the route
 * editor's click path.
 */
export const MIDNIGHT_COMMUTE_REFRESH_VERSION = 'midnight-commute-refresh-v2';

export function createDailyModeShareInvalidation({ recalculate, refreshActiveTile = null }) {
  const dirtyReasons = new Set();
  let running = null, lastRun = null;
  let cancelled = false;
  return {
    markDirty(reason) {
      if (!cancelled) dirtyReasons.add(reason);
    },
    flushAtMidnight(day) {
      // Native day hooks and the cached tick can observe the same boundary.
      // Both must wait for the existing batch before the clock can proceed.
      if (running) return running;
      if (cancelled || dirtyReasons.size === 0) return Promise.resolve({ status: 'not-dirty', day });
      // Edits arriving during a batch belong to the following midnight, even
      // if the host delivers another notification after this batch finished.
      if (lastRun && lastRun.day === day) return Promise.resolve({ status: 'already-refreshed', day });
      const reasons = [...dirtyReasons].sort();
      dirtyReasons.clear();
      const run = async () => {
        try {
          // All-settled keeps the day barrier in place even if one worker fails
          // early. Neither job waits for the other to start.
          const [active, cross] = await Promise.allSettled([
            Promise.resolve().then(() => refreshActiveTile?.(day) ?? { status: 'disabled', day }),
            Promise.resolve().then(() => recalculate('midnight-change', day, reasons)),
          ]);
          if (active.status === 'rejected') throw active.reason;
          if (cross.status === 'rejected') throw cross.reason;
          const result = cross.value;
          lastRun = { day, reasons, activeTileRefresh: active.value, status: 'complete' };
          // The game-entry integration returns null when recalculation fails or
          // cannot run. Preserve the flag so the following midnight retries it.
          if (result == null || result.nativeFinanceProfile?.status === 'pending' || active.value?.status === 'stale') {
            if (!cancelled) for (const reason of reasons) dirtyReasons.add(reason);
            lastRun.status = 'pending';
          }
          return result;
        } catch (error) {
          if (!cancelled) for (const reason of reasons) dirtyReasons.add(reason);
          lastRun = { day, reasons, status: 'failed', error: String(error?.message ?? error) };
          throw error;
        } finally {
          running = null;
        }
      };
      running = run();
      return running;
    },
    cancel() {
      cancelled = true;
      dirtyReasons.clear();
    },
    isDirty: () => dirtyReasons.size > 0,
    snapshot: () => ({ version: MIDNIGHT_COMMUTE_REFRESH_VERSION, running: running != null,
      dirtyReasons: [...dirtyReasons].sort(), lastRun }),
  };
}

/** Hourly ticks settle commuters; midnight optionally consumes the stale flag. */
export function registerCrossTileClockHooks(hooks, { hourChanged, dayChanged }) {
  hooks?.onHourChange?.(hourChanged);
  hooks?.onDayChange?.(dayChanged);
}
