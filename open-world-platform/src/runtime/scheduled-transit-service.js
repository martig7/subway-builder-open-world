// Native service periods, shared by routing and the seat ledger.
export const NATIVE_SERVICE_PERIODS = Object.freeze([
  [0, 3, 'veryLowDemand'], [3, 6, 'lowDemand'], [6, 7, 'mediumDemand'],
  [7, 10, 'highDemand'], [10, 16, 'mediumDemand'], [16, 19, 'highDemand'],
  [19, 20, 'mediumDemand'], [20, 23, 'lowDemand'], [23, 24, 'veryLowDemand'],
]);
export function trainCountTimetable(schedule, idealCount, cycle) {
  if (!schedule || !(cycle > 0)) return null;
  return { mode: 'timetable', periods: NATIVE_SERVICE_PERIODS.map(([startHour, endHour, key]) => {
    const count = Math.max(0, Number.isFinite(schedule[key]) ? schedule[key] : idealCount);
    return { startHour, endHour, headwaySeconds: count > 0 ? cycle / count : 0 };
  }) };
}
export function serviceHeadway(route, time) {
  const cycle = route.cycleTimeSeconds ?? route.stComboTimings?.at(-1)?.departureTime;
  if (route.timetableSchedule?.mode === 'timetable') {
    const hour = ((time % 86400) + 86400) % 86400 / 3600;
    const p = route.timetableSchedule.periods?.find(p => p.startHour <= p.endHour
      ? hour >= p.startHour && hour < p.endHour : hour >= p.startHour || hour < p.endHour);
    return Math.max(0, p?.headwaySeconds ?? 0);
  }
  return cycle > 0 && route.serviceCount > 0 ? cycle / route.serviceCount : 0;
}
export function nextServiceDeparture(route, offset, ready) {
  const headway = serviceHeadway(route, ready);
  if (!(headway > 0)) return null;
  const departure = offset + Math.ceil((ready - offset - 1e-7) / headway) * headway;
  // A departure may cross a period boundary into a closure or a new frequency.
  const nextHeadway = serviceHeadway(route, departure);
  if (!(nextHeadway > 0)) return null;
  if (nextHeadway !== headway) {
    const adjusted = offset + Math.ceil((departure - offset - 1e-7) / nextHeadway) * nextHeadway;
    return serviceHeadway(route, adjusted) > 0 ? adjusted : null;
  }
  return departure;
}
