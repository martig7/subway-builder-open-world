import { wholePeopleInInterval } from './whole-people.js';

/** Integrate cached hourly rates over exactly the interval owned by this mode. */
export function* cachedSimulationPostingSteps({ profile, expenses, from, to, sessionId }) {
  const result = { revenue: 0, expenseCategories: {}, revenueByRoute: {}, expensesByRoute: {},
    completedCommutes: [], hourlyPostings: [], targetElapsedSeconds: to,
    postingId: `cached-simulation:${sessionId}:${from}:${to}` };
  const add = (target, source, scale) => {
    for (const [id, amount] of Object.entries(source ?? {})) target[id] = (target[id] ?? 0) + amount * scale;
  };
  for (let start = from; start < to;) {
    const hour = Math.floor(start / 3600), end = Math.min(to, (hour + 1) * 3600);
    const fraction = (end - start) / 3600, value = profile.hourly[hour % 24];
    const row = { hour, revenue: (value?.revenue ?? 0) * fraction,
      revenueByRoute: {}, expensesByRoute: {}, expenseCategories: {} };
    add(row.revenueByRoute, value?.revenueByRoute, fraction);
    for (const [id, rates] of Object.entries(expenses?.routeHourly ?? {})) {
      row.expensesByRoute[id] = (rates[hour % 24] ?? 0) * fraction;
    }
    row.expenseCategories.trainOperational = Object.values(row.expensesByRoute).reduce((a, b) => a + b, 0);
    for (const item of expenses?.infrastructureItems ?? []) {
      row.expenseCategories[item.category] = (row.expenseCategories[item.category] ?? 0) + item.hourlyCost * fraction;
    }
    row.expenses = Object.values(row.expenseCategories).reduce((a, b) => a + b, 0);
    result.hourlyPostings.push(row);
    result.revenue += row.revenue;
    add(result.revenueByRoute, row.revenueByRoute, 1);
    add(result.expensesByRoute, row.expensesByRoute, 1);
    add(result.expenseCategories, row.expenseCategories, 1);
    for (const commute of value?.completedCommutes ?? []) {
      const hourStart = hour * 3600;
      const size = wholePeopleInInterval(commute.size, start - hourStart, end - hourStart, 3600);
      if (size <= 0) continue;
      result.completedCommutes.push({ ...commute, size,
        popId: `cached-native:${sessionId}:${commute.popId}:${commute.origin}:${start}:${end}`,
        journeyStart: start, journeyEnd: end,
      });
      yield;
    }
    yield;
    start = end;
  }
  return result;
}

export function cachedSimulationPosting(input) {
  const steps = cachedSimulationPostingSteps(input);
  let next; do { next = steps.next(); } while (!next.done);
  return next.value;
}
