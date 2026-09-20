import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedModeChooser, BOUNDED_MODE_CHOICE_VERSION } from '../src/runtime/bounded-mode-choice.js';

// Frozen pre-optimization income model and mode-count oracle. These must not
// import the optimized chooser through cross-tile-mode-choice.js, so routing
// integration cannot accidentally turn this parity check into a self-test.
const DEFAULT_INCOME_RULES = Object.freeze({ INCOME_MEAN: 60_000, INCOME_STD_DEV: 25_000,
  MINIMUM_INCOME: 15_000, MAXIMUM_INCOME: 200_000, HOURS_WORKED_PER_YEAR: 1_860,
  MIN_TRANSIT_CHOICE: 10 });
function inverseNormalCDF(value) {
  const p = Math.max(1e-4, Math.min(0.9999, value));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function incomeValueAt(index, population, rules) {
  const percentile = index / Math.max(population - 1, 1);
  let income = rules.INCOME_MEAN + inverseNormalCDF(percentile) * rules.INCOME_STD_DEV;
  income = Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME));
  const noise = (index * 362436069 % 1e6) / 1e6;
  if (income <= rules.MINIMUM_INCOME + 5_000) income = rules.INCOME_MEAN + inverseNormalCDF(0.1 + noise * 0.85) * rules.INCOME_STD_DEV;
  else if (noise < 0.1) income += ((index * 123456789 % 1e6) / 1e6) * 100_000;
  return Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME)) / rules.HOURS_WORKED_PER_YEAR / 3600;
}
function originalChoose(population, rules, metrics, valueAt = incomeValueAt) {
  const result = { driving: 0, walking: 0, transit: 0, unknown: 0 };
  const drivingTimeCost = metrics.driving.perceivedSeconds * metrics.driving.shortTripPenalty;
  const drivingMoneyCost = metrics.driving.moneyCost * metrics.driving.shortTripPenalty;
  const transitTimeCost = metrics.transit.perceivedSeconds;
  const transitMoneyCost = metrics.transit.moneyCost;
  const walkingTimeCost = metrics.walking.perceivedSeconds;
  for (let i = 0; i < Math.max(0, Math.ceil(population)); i++) {
    const hourlyValue = valueAt(i, population, rules);
    let bestCost = drivingTimeCost * hourlyValue + drivingMoneyCost;
    let mode = 'driving';
    const transitGeneralizedCost = transitTimeCost * hourlyValue + transitMoneyCost;
    if (transitGeneralizedCost < bestCost) { bestCost = transitGeneralizedCost; mode = 'transit'; }
    if (walkingTimeCost * hourlyValue < bestCost) mode = 'walking';
    result[mode] += 1;
  }
  if (result.transit < rules.MIN_TRANSIT_CHOICE) { result.driving += result.transit; result.transit = 0; }
  return result;
}
const metrics = (dt, dm, tt, tm, wt, penalty = 1) => ({
  driving: { perceivedSeconds: dt, moneyCost: dm, shortTripPenalty: penalty },
  transit: { perceivedSeconds: tt, moneyCost: tm }, walking: { perceivedSeconds: wt },
});

test('bounded mode choice matches the original noisy-income model across randomized cases', () => {
  const chooser = createBoundedModeChooser({ incomeValueAt });
  let seed = 93817;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 3000; i++) {
    const population = i < 100 ? i / 3 : Math.floor(random() * 5000);
    const rules = { ...DEFAULT_INCOME_RULES, INCOME_MEAN: 20000 + random() * 80000,
      INCOME_STD_DEV: random() * 40000, MIN_TRANSIT_CHOICE: Math.floor(random() * 30) };
    const value = metrics(random() * 10000, random() * 40, random() < 0.2 ? Infinity : random() * 10000,
      random() * 40, random() * 20000, 1 + random());
    assert.deepEqual(chooser.choose(population, rules, value), originalChoose(population, rules, value), `case ${i}`);
    assert.ok(chooser.stats.cacheBytes <= 8 * 1024 * 1024);
    assert.ok(chooser.stats.cacheEntries <= 4096);
  }
  assert.ok(chooser.stats.uniformlyCountedValues > chooser.stats.individuallyCountedValues);
  assert.equal(BOUNDED_MODE_CHOICE_VERSION, 'bounded-mode-choice-v1');
});

test('strict ties and numerically ambiguous costs use the original comparison semantics', () => {
  const values = [0, Number.MIN_VALUE, 0.001, 0.01, 0.010000000000000002, 1, 1e100, NaN];
  const valueAt = i => values[i % values.length];
  const chooser = createBoundedModeChooser({ incomeValueAt: valueAt, scanThreshold: 0 });
  const rules = { MIN_TRANSIT_CHOICE: 0 };
  for (const value of [metrics(1, 0, 1, 0, 1), metrics(100, 1, 100, 1, 1000),
    metrics(100, 1, 100.00000000000001, 0.9999999999999999, 1000),
    metrics(Infinity, 0, Infinity, 0, Infinity), metrics(1, 1, Infinity, 3, 5),
    metrics(NaN, 1, 0, 0, 0), metrics(1e300, 1e300, 1e300, 2e300, Infinity),
    metrics(-10, 5, -11, 5, -10), metrics(1, -Infinity, 0, 0, 0)]) {
    assert.deepEqual(chooser.choose(700, rules, value), originalChoose(700, rules, value, valueAt));
  }
});

test('small and oversized cache budgets keep counts exact and reset retained memory', () => {
  const chooser = createBoundedModeChooser({ incomeValueAt, maxCacheBytes: 1024, maxCacheEntries: 2 });
  for (const population of [100, 100, 101, 25, 25, 500, 0, -1]) {
    for (const minimum of [0, 10, 1000]) {
      const rules = { ...DEFAULT_INCOME_RULES, MIN_TRANSIT_CHOICE: minimum, INCOME_MEAN: 60000 + minimum };
      const value = metrics(1000, 8, 1200, 3, 1800);
      assert.deepEqual(chooser.choose(population, rules, value), originalChoose(population, rules, value));
      assert.deepEqual(chooser.choose(population, rules, value), originalChoose(population, rules, value));
      assert.ok(chooser.stats.cacheBytes <= 1024);
      assert.ok(chooser.stats.cacheEntries <= 2);
    }
  }
  assert.ok(chooser.stats.evictions > 0);
  assert.ok(chooser.stats.oversizedCalls > 0);
  assert.ok(chooser.stats.cacheHits > 0);
  chooser.clear();
  assert.equal(chooser.stats.cacheBytes, 0);
  assert.equal(chooser.stats.cacheEntries, 0);
  const uncached = createBoundedModeChooser({ incomeValueAt, maxCacheBytes: 0, maxCacheEntries: 0 });
  const value = metrics(1000, 8, 1200, 3, 1800);
  assert.deepEqual(uncached.choose(10000, DEFAULT_INCOME_RULES, value), originalChoose(10000, DEFAULT_INCOME_RULES, value));
  assert.equal(uncached.stats.cacheBytes, 0);
  assert.equal(uncached.stats.cacheEntries, 0);
  assert.equal(uncached.stats.individuallyCountedValues, 10000);
});

test('every income rule affecting generated values participates in cache identity', () => {
  const chooser = createBoundedModeChooser({ incomeValueAt });
  const value = metrics(1000, 8, 1200, 3, 1800);
  const variants = [{}, { INCOME_MEAN: 90000 }, { INCOME_STD_DEV: 5000 },
    { MINIMUM_INCOME: 60000 }, { MAXIMUM_INCOME: 30000 }, { HOURS_WORKED_PER_YEAR: 500 }];
  for (const variant of variants) {
    const rules = { ...DEFAULT_INCOME_RULES, ...variant };
    assert.deepEqual(chooser.choose(200, rules, value), originalChoose(200, rules, value));
  }
  assert.equal(chooser.stats.cacheMisses, variants.length);
  const rules = { ...DEFAULT_INCOME_RULES, MIN_TRANSIT_CHOICE: 1000 };
  assert.deepEqual(chooser.choose(200, rules, value), originalChoose(200, rules, value));
  assert.equal(chooser.stats.cacheHits, 1, 'decision thresholds do not change the income distribution');
});
