import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createFastModeChooser } from './mode-choice.js';

const sourceUrl = new URL('../../src/runtime/cross-tile-mode-choice.js', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replace(
  "from './routing-graph-index.js'", `from '${new URL('./routing-graph-index.js', sourceUrl).href}'`,
) + '\nexport { chooseModesFromMetrics, incomeForPerson, rulesWithDefaults };';
const oracle = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const rules = oracle.rulesWithDefaults();
const fast = createFastModeChooser({ incomeValueAt: (i, n, r) => oracle.incomeForPerson(i, n, r) / r.HOURS_WORKED_PER_YEAR / 3600 });
let seed = 93817;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const fixtures = Array.from({ length: 5000 }, () => ({
  driving: { perceivedSeconds: random() * 10000, moneyCost: random() * 40, shortTripPenalty: 1 + random() },
  transit: { perceivedSeconds: random() < 0.2 ? Infinity : random() * 10000, moneyCost: random() * 40 },
  walking: { perceivedSeconds: random() * 20000 },
}));
const measure = (choose, population) => {
  let checksum = 0;
  const start = performance.now();
  for (const input of fixtures) {
    const result = choose(population, rules, input);
    checksum += result.driving + 2 * result.walking + 3 * result.transit;
  }
  return { milliseconds: performance.now() - start, checksum };
};
const rows = [];
for (const population of [100, 1000, 10000]) {
  measure(oracle.chooseModesFromMetrics, population); measure(fast.choose, population);
  const baseline = measure(oracle.chooseModesFromMetrics, population), candidate = measure(fast.choose, population);
  if (baseline.checksum !== candidate.checksum) throw new Error('Mode counts differ');
  rows.push({ population, queries: fixtures.length, baselineMs: baseline.milliseconds,
    candidateMs: candidate.milliseconds, speedup: baseline.milliseconds / candidate.milliseconds });
}
console.log(JSON.stringify({ warning: 'Microbenchmark only; excludes routing and must not be interpreted as whole-evaluator speedup.', rows, stats: fast.stats }, null, 2));
