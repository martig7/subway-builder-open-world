export const STRUCTURAL_NETWORK_HOOKS = Object.freeze([
  'onRouteCreated', 'onRouteDeleted', 'onScheduleChange',
]);

export const FARE_HOOKS = Object.freeze([
  'onTicketPriceChanged', 'onFareGroupsChanged',
]);

/**
 * Register only service-level invalidations. Blueprint station/track edits do
 * not carry passengers until a route or schedule uses them, while native
 * trains spawn/despawn as part of ordinary timetable operation.
 */
export function registerModeShareInvalidationHooks(hooks, { routeChanged, scheduleChanged, fareChanged }) {
  hooks?.onRouteCreated?.(routeChanged);
  hooks?.onRouteDeleted?.(routeChanged);
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
