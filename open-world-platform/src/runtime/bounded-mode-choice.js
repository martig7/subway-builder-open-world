// Job-owned mode-choice counts. The provider preserves the deterministic income
// model; this module only skips identical decisions over certified ranges.
export const BOUNDED_MODE_CHOICE_VERSION = 'bounded-mode-choice-v1';
const INCOME_KEYS = [
  'INCOME_MEAN', 'INCOME_STD_DEV', 'MINIMUM_INCOME', 'MAXIMUM_INCOME',
  'HOURS_WORKED_PER_YEAR',
];

function costs(metrics) {
  return [
    [metrics.driving.perceivedSeconds * metrics.driving.shortTripPenalty,
      metrics.driving.moneyCost * metrics.driving.shortTripPenalty],
    [metrics.transit.perceivedSeconds, metrics.transit.moneyCost],
    [metrics.walking.perceivedSeconds, 0],
  ];
}

function chooseAt(value, lines) {
  let cost = lines[0][0] * value + lines[0][1], mode = 0;
  const transit = lines[1][0] * value + lines[1][1];
  if (transit < cost) { cost = transit; mode = 1; }
  if (lines[2][0] * value + lines[2][1] < cost) mode = 2;
  return mode;
}

// Returns -1/0/+1 only when that comparison holds throughout [low, high].
// null means uncertainty, including a crossing or a floating-point tie region.
function compareRange(left, right, low, high) {
  const [a, b] = left, [c, d] = right;
  if (a === c && b === d && Number.isFinite(a) && Number.isFinite(b)) return 0;
  const l0 = a * low + b, l1 = a * high + b;
  const r0 = c * low + d, r1 = c * high + d;
  if (l0 === Infinity && l1 === Infinity && Number.isFinite(r0) && Number.isFinite(r1)) return 1;
  if (r0 === Infinity && r1 === Infinity && Number.isFinite(l0) && Number.isFinite(l1)) return -1;
  if (![a, b, c, d, l0, l1, r0, r1].every(Number.isFinite)) return null;
  const scale = Math.max(Math.abs(low), Math.abs(high)) * (Math.abs(a) + Math.abs(c))
    + Math.abs(b) + Math.abs(d);
  // Covers errors in each multiply/add and the difference calculation, with
  // substantial headroom. Near a boundary we use the original comparisons.
  const error = scale * (32 * Number.EPSILON) + 32 * Number.MIN_VALUE;
  const slope = a - c, intercept = b - d;
  const atLow = slope * low + intercept, atHigh = slope * high + intercept;
  if (Math.max(atLow, atHigh) < -error) return -1;
  if (Math.min(atLow, atHigh) > error) return 1;
  return null;
}

function uniformMode(mode, lines, low, high) {
  if (mode === 0) {
    const transit = compareRange(lines[1], lines[0], low, high);
    const walking = compareRange(lines[2], lines[0], low, high);
    return transit !== null && transit >= 0 && walking !== null && walking >= 0;
  }
  if (mode === 1) {
    const walking = compareRange(lines[2], lines[1], low, high);
    return compareRange(lines[1], lines[0], low, high) === -1 && walking !== null && walking >= 0;
  }
  return compareRange(lines[2], lines[0], low, high) === -1
    && compareRange(lines[2], lines[1], low, high) === -1;
}

/**
 * Count deterministic passengers with original driving/transit/walking tie order.
 * Sorted income distributions use an LRU with explicit byte and entry limits.
 * Oversize populations stream through the original calculation, allocating no
 * population-sized array. Cache eviction precedes allocation of replacements.
 *
 * incomeValueAt(index, population, rules) returns the existing income value per
 * second. Its rules dependency must be limited to INCOME_KEYS. Own one chooser
 * per routing cache/evaluation job, then call clear() when that owner resets.
 * The byte limit covers retained arrays, not sorting scratch or the whole heap.
 */
export function createBoundedModeChooser({ incomeValueAt, maxCacheBytes = 8 * 1024 * 1024,
  maxCacheEntries = 4096, scanThreshold = 32 } = {}) {
  if (typeof incomeValueAt !== 'function') throw new TypeError('incomeValueAt must be a function');
  for (const [name, value] of Object.entries({ maxCacheBytes, maxCacheEntries, scanThreshold })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  const cache = new Map();
  const stats = { calls: 0, cacheHits: 0, cacheMisses: 0, cacheBytes: 0, cacheEntries: 0,
    generatedValues: 0, individuallyCountedValues: 0, uniformlyCountedValues: 0,
    oversizedCalls: 0, evictions: 0 };

  function distribution(population, rules, length) {
    const bytes = length * Float64Array.BYTES_PER_ELEMENT;
    if (bytes > maxCacheBytes || maxCacheEntries === 0) { stats.oversizedCalls++; return null; }
    const key = [population, ...INCOME_KEYS.map(name => rules[name])].join('|');
    let values = cache.get(key);
    if (values) {
      stats.cacheHits++;
      cache.delete(key); cache.set(key, values);
      return values;
    }
    stats.cacheMisses++;
    while (cache.size && (stats.cacheBytes + bytes > maxCacheBytes || cache.size >= maxCacheEntries)) {
      const oldest = cache.keys().next().value;
      stats.cacheBytes -= cache.get(oldest).byteLength;
      cache.delete(oldest); stats.evictions++;
    }
    values = new Float64Array(length);
    for (let i = 0; i < length; i++) values[i] = incomeValueAt(i, population, rules);
    stats.generatedValues += length;
    values.sort();
    cache.set(key, values);
    stats.cacheBytes += values.byteLength; stats.cacheEntries = cache.size;
    return values;
  }

  function choose(population, rules, metrics) {
    const length = Math.max(0, Math.ceil(population));
    if (!Number.isSafeInteger(length)) throw new RangeError('population must have a finite safe length');
    stats.calls++;
    const lines = costs(metrics), counts = [0, 0, 0];
    const values = distribution(population, rules, length);
    function countRange(start, end) {
      const size = end - start;
      if (!size) return;
      if (size > Math.max(1, scanThreshold)) {
        const mode = chooseAt(values[Math.floor((start + end) / 2)], lines);
        if (uniformMode(mode, lines, values[start], values[end - 1])) {
          counts[mode] += size; stats.uniformlyCountedValues += size; return;
        }
        const middle = Math.floor((start + end) / 2);
        countRange(start, middle); countRange(middle, end);
        return;
      }
      for (let i = start; i < end; i++) counts[chooseAt(values[i], lines)]++;
      stats.individuallyCountedValues += size;
    }
    if (values) countRange(0, length);
    else {
      for (let i = 0; i < length; i++) counts[chooseAt(incomeValueAt(i, population, rules), lines)]++;
      stats.generatedValues += length; stats.individuallyCountedValues += length;
    }
    if (counts[1] < rules.MIN_TRANSIT_CHOICE) { counts[0] += counts[1]; counts[1] = 0; }
    return { driving: counts[0], walking: counts[2], transit: counts[1], unknown: 0 };
  }

  return {
    choose,
    stats,
    clear() { cache.clear(); stats.cacheBytes = 0; stats.cacheEntries = 0; },
  };
}
