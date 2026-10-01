export const NATIVE_RELIABILITY_SNAPSHOT_VERSION = 'native-reliability-snapshot-v1';

/** Native 1.7.2 stores reliability as numeric tuples, not its live history
 * objects. Refresh only this field when reusing a save's schema; generating
 * another full save would also compress the entire Tile View's demand. */
export function serializeNativeReliabilityHistory(history) {
  if (history == null) return undefined;
  if (history.v === 1) return history;
  const currentHour = {}, byRoute = {};
  for (const [routeId, sections] of Object.entries(history.currentHour ?? {})) {
    const saved = {};
    for (const [sectionId, sample] of Object.entries(sections)) {
      if (sample.count === 0) continue;
      saved[sectionId] = [sample.count, sample.onTime, Math.round(sample.delaySum), Math.round(sample.addedSum)];
    }
    if (Object.keys(saved).length) currentHour[routeId] = saved;
  }
  for (const [routeId, sections] of Object.entries(history.byRoute ?? {})) {
    const saved = {};
    for (const [sectionId, samples] of Object.entries(sections)) {
      if (!samples.length) continue;
      const tuples = [];
      for (const sample of samples) {
        tuples.push(sample.timestamp, sample.count, sample.onTime, Math.round(sample.delaySum), Math.round(sample.addedSum));
      }
      saved[sectionId] = tuples;
    }
    if (Object.keys(saved).length) byRoute[routeId] = saved;
  }
  if (!Object.keys(currentHour).length && !Object.keys(byRoute).length) return undefined;
  return { v: 1, lastHourTimestamp: history.lastHourTimestamp, currentHour, byRoute };
}
