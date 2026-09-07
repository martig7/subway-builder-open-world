import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { calculateCrossTileModeShares, createCrossTileRoutingCache } from '../src/runtime/cross-tile-mode-choice.js';

const [inputPath, baselinePath, outputPath] = process.argv.slice(2);
if (!inputPath || !baselinePath) throw new Error('Usage: node scripts/benchmark-cross-routing.mjs <captured-input.json> <baseline-module.mjs> [report.json]');
const input = JSON.parse(await readFile(inputPath,'utf8'));
const baseline = await import(pathToFileURL(path.resolve(baselinePath)).href);
const digest = result => {
  const {routingStats,...outcomes} = result;
  return createHash('sha256').update(JSON.stringify(outcomes,(_,v)=>v instanceof Map ? [...v] : v)).digest('hex');
};
function measure(run) {
  const started = performance.now(), result = run();
  return {milliseconds:performance.now()-started,digest:digest(result),evaluatedPops:result.evaluatedPops,transitViablePops:result.transitViablePops,routingStats:result.routingStats};
}
const cache = createCrossTileRoutingCache();
const cold=[],warm=[],old=[];
// Untimed JIT warmup; the first measured optimized pass still has an empty cache.
baseline.calculateCrossTileModeShares(input);
calculateCrossTileModeShares(input);
for(let i=0;i<5;i++) {
  old.push(measure(()=>baseline.calculateCrossTileModeShares(input)));
  cache.clear();
  cold.push(measure(()=>calculateCrossTileModeShares({...input,routingCache:cache})));
  warm.push(measure(()=>calculateCrossTileModeShares({...input,routingCache:cache})));
}
const oracle = measure(()=>calculateCrossTileModeShares({...input,routingCache:createCrossTileRoutingCache({enabled:false})}));
const median=rows=>rows.map(r=>r.milliseconds).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
const report={input:path.basename(inputPath),worldId:input.worldId,requestedDepartureSeconds:input.requestedDepartureSeconds,
  node:process.version,baselineMedianMs:median(old),coldMedianMs:median(cold),warmMedianMs:median(warm),
  coldSpeedup:median(old)/median(cold),warmSpeedup:median(old)/median(warm),
  matchesBaseline:old.every(r=>r.digest===cold[0].digest),matchesExactOracle:[...cold,...warm].every(r=>r.digest===oracle.digest),
  baseline:old,cold,warm,oracle};
if(outputPath) await writeFile(outputPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.matchesExactOracle) process.exitCode=1;
