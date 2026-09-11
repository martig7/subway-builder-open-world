const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function wholePeople(value) {
  return Math.max(0, Math.round(finite(value, 0)));
}

/** Allocate a rounded population total by largest remainder, with stable ties. */
export function wholePeopleDistribution(distribution, value) {
  const people = wholePeople(value);
  if (!people) return [];
  const weighted = distribution.map(([bucket, weight], index) => ({
    bucket,
    index,
    weight: Math.max(0, finite(weight, 0)),
  }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) return [];
  const allocations = weighted.map((entry) => {
    const exact = people * entry.weight / totalWeight;
    return { ...entry, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const remaining = people - allocations.reduce((sum, entry) => sum + entry.count, 0);
  const ranked = [...allocations].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index++) ranked[index].count++;
  return allocations.filter((entry) => entry.count > 0).map(({ bucket, count }) => [bucket, count]);
}

/** Count evenly distributed whole people within a half-open portion of a period. */
export function wholePeopleInInterval(value, start, end, period) {
  const people = wholePeople(value);
  const boundedStart = Math.max(0, Math.min(period, finite(start, 0)));
  const boundedEnd = Math.max(boundedStart, Math.min(period, finite(end, 0)));
  return Math.floor(people * boundedEnd / period) - Math.floor(people * boundedStart / period);
}
