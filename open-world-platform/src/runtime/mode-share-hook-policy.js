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
export function createDailyModeShareInvalidation({ recalculate }) {
  const dirtyReasons = new Set();
  let running = false;
  let cancelled = false;
  return {
    markDirty(reason) {
      if (!cancelled) dirtyReasons.add(reason);
    },
    async flushAtMidnight(day) {
      if (cancelled || running || dirtyReasons.size === 0) return { status: 'not-dirty', day };
      const reasons = [...dirtyReasons].sort();
      dirtyReasons.clear();
      running = true;
      try {
        const result = await recalculate('midnight-change', day, reasons);
        // The game-entry integration returns null when recalculation fails or
        // cannot run. Preserve the flag so the following midnight retries it.
        if (result == null || result.nativeFinanceProfile?.status === 'pending') {
          for (const reason of reasons) dirtyReasons.add(reason);
        }
        return result;
      } catch (error) {
        for (const reason of reasons) dirtyReasons.add(reason);
        throw error;
      } finally {
        running = false;
      }
    },
    cancel() {
      cancelled = true;
      dirtyReasons.clear();
    },
    isDirty: () => dirtyReasons.size > 0,
  };
}

/** Hourly ticks settle commuters; midnight optionally consumes the stale flag. */
export function registerCrossTileClockHooks(hooks, { hourChanged, dayChanged }) {
  hooks?.onHourChange?.(hourChanged);
  hooks?.onDayChange?.(dayChanged);
}
