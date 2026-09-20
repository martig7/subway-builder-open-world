import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFastModeChooser } from './mode-choice.js';

// Read the current source implementation as the oracle, including its actual
// income noise/clamping, instead of maintaining a duplicate in this test.
const sourceUrl = new URL('../../src/runtime/cross-tile-mode-choice.js', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replace(
  "from './routing-graph-index.js'", `from '${new URL('./routing-graph-index.js', sourceUrl).href}'`,
) + '\nexport { chooseModesFromMetrics, incomeForPerson, rulesWithDefaults };';
const oracle = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const incomeValueAt = (i, n, rules) => oracle.incomeForPerson(i, n, rules) / rules.HOURS_WORKED_PER_YEAR / 3600;
const metrics = (dt, dm, tt, tm, wt, penalty = 1) => ({
  driving: { perceivedSeconds: dt, moneyCost: dm, shortTripPenalty: penalty },
  transit: { perceivedSeconds: tt, moneyCost: tm }, walking: { perceivedSeconds: wt },
});

test('sorted range counting preserves current noisy income model and all mode counts', () => {
  const chooser = createFastModeChooser({ incomeValueAt });
  let seed = 93817;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 3000; i++) {
    const population = i < 100 ? i / 3 : Math.floor(random() * 5000);
    const rules = oracle.rulesWithDefaults({ INCOME_MEAN: 20000 + random() * 80000,
      INCOME_STD_DEV: random() * 40000, MIN_TRANSIT_CHOICE: Math.floor(random() * 30) });
    const value = metrics(random() * 10000, random() * 40, random() < 0.2 ? Infinity : random() * 10000,
      random() * 40, random() * 20000, 1 + random());
    assert.deepEqual(chooser.choose(population, rules, value), oracle.chooseModesFromMetrics(population, rules, value), `case ${i}`);
    assert.ok(chooser.stats.cacheBytes <= 8 * 1024 * 1024);
  }
  assert.ok(chooser.stats.uniformlyCountedValues > chooser.stats.individuallyCountedValues);
});

test('strict ties, unavailable modes, zero income, and near-tie floating point values remain exact', () => {
  const values = Float64Array.from([0, Number.MIN_VALUE, 0.001, 0.01, 0.010000000000000002, 1, 1e100]);
  const chooser = createFastModeChooser({ incomeValueAt: i => values[i % values.length], scanThreshold: 0 });
  const rules = { MIN_TRANSIT_CHOICE: 0 };
  for (const value of [metrics(1, 0, 1, 0, 1), metrics(100, 1, 100, 1, 1000),
    metrics(100, 1, 100.00000000000001, 0.9999999999999999, 1000),
    metrics(Infinity, 0, Infinity, 0, Infinity), metrics(1, 1, Infinity, 3, 5),
    metrics(NaN, 1, 0, 0, 0), metrics(1e300, 1e300, 1e300, 2e300, Infinity),
    metrics(-10, 5, -11, 5, -10), metrics(1, -Infinity, 0, 0, 0)]) {
    const expected = { driving: 0, walking: 0, transit: 0, unknown: 0 };
    for (let i = 0; i < 700; i++) {
      const v = values[i % values.length];
      let cost = value.driving.perceivedSeconds * v + value.driving.moneyCost, mode = 'driving';
      const transit = value.transit.perceivedSeconds * v + value.transit.moneyCost;
      if (transit < cost) { cost = transit; mode = 'transit'; }
      if (value.walking.perceivedSeconds * v < cost) mode = 'walking';
      expected[mode]++;
    }
    assert.deepEqual(chooser.choose(700, rules, value), expected);
  }
});

test('minimum transit threshold, income rule changes and cache limits preserve the result', () => {
  const chooser = createFastModeChooser({ incomeValueAt, maxCacheBytes: 1024, maxCacheEntries: 2 });
  for (const population of [100, 100, 101, 25, 25, 500, 0, -1]) {
    for (const minimum of [0, 10, 1000]) {
      const rules = oracle.rulesWithDefaults({ MIN_TRANSIT_CHOICE: minimum, INCOME_MEAN: 60000 + minimum });
      const value = metrics(1000, 8, 1200, 3, 1800);
      assert.deepEqual(chooser.choose(population, rules, value), oracle.chooseModesFromMetrics(population, rules, value));
      assert.deepEqual(chooser.choose(population, rules, value), oracle.chooseModesFromMetrics(population, rules, value));
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
});
