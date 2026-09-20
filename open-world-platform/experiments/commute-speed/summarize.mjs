import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? '.analysis/commute-speed-full');
const results = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
const baselineVariant = results.variants.includes('wasm') ? 'wasm' : results.variants[0];
if (!results.complete || !results.sourceSaveUnchanged) throw Error('Only completed replays with unchanged input snapshots may be summarized');
const expected = new Set();
for (let repeat=0;repeat<results.repeats;repeat++) for(const tile of results.tiles) for(const variant of results.variants) expected.add(JSON.stringify([repeat,tile,variant]));
for(const row of results.records) if(!expected.delete(JSON.stringify([row.repeat,row.tile,row.variant]))) throw Error('Duplicate or unexpected measurement');
if(expected.size) throw Error('Incomplete measurement grid');
const median = values => { const sorted = [...values].sort((a,b)=>a-b); const i=Math.floor(sorted.length/2); return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2; };
const rows = [];
for (const variant of results.variants) {
  const selected = results.records.filter(r=>r.variant===variant);
  const totals = [...new Set(selected.map(r=>r.repeat))].map(repeat=>selected.filter(r=>r.repeat===repeat).reduce((a,r)=>a+r.milliseconds/1000,0));
  rows.push({variant, combinedMedianSeconds:median(totals), passSeconds:totals,
    maximumProcessRssMiB:Math.max(...selected.map(r=>r.memory.processMaxRssKiB/1024)),
    maximumSampledHeapMiB:Math.max(...selected.map(r=>r.memory.sampledPeak.heapUsed/2**20)),
    exactAssignments:selected.every(r=>r.assignmentHash===results.records.find(b=>b.variant===baselineVariant&&b.tile===r.tile&&b.repeat===r.repeat)?.assignmentHash),
    exactProfiles:selected.every(r=>r.profileHash===results.records.find(b=>b.variant===baselineVariant&&b.tile===r.tile&&b.repeat===r.repeat)?.profileHash),
    perTile:results.tiles.map(tile=>({tile,medianSeconds:median(selected.filter(r=>r.tile===tile).map(r=>r.milliseconds/1000))})) });
}

const approximations=[];
for (const variant of results.variants.filter(v=>v.includes('reuse') && results.collectedMetrics === true)) {
  let totalWeight=0, changedWeight=0, unavailableChanges=0, weightedPositiveSeconds=0, worseWeight=0, totalRevenue=0, candidateRevenue=0;
  const errors=[]; let maxErrorSeconds=0,maxRelativeError=0;
  const modes={baseline:{},candidate:{}};
  const perRoute={};
  for (const tile of results.tiles) {
    const baseline=JSON.parse(await readFile(path.join(directory,`${tile}.wasm.0.json.metrics.json`),'utf8'));
    const candidate=JSON.parse(await readFile(path.join(directory,`${tile}.${variant}.0.json.metrics.json`),'utf8'));
    if (baseline.length!==candidate.length) throw Error('Metric lengths differ');
    for(let i=0;i<baseline.length;i++) {
      if(baseline[i][0]!==candidate[i][0]) throw Error('Metric ordering differs');
      for(let d=1;d<=2;d++) {
        const b=baseline[i][d], c=candidate[i][d], weight=Object.values(b[2]).reduce((a,n)=>a+n,0);
        totalWeight+=weight;
        if(JSON.stringify(b)!==JSON.stringify(c)) changedWeight+=weight;
        for(const [key,value]of Object.entries(b[2])) modes.baseline[key]=(modes.baseline[key]??0)+value;
        for(const [key,value]of Object.entries(c[2])) modes.candidate[key]=(modes.candidate[key]??0)+value;
        if((b[0]==null)!==(c[0]==null)) {unavailableChanges++;continue;}
        if(b[0]!=null) {
          const error=Math.max(0,c[0]-b[0]);
          weightedPositiveSeconds+=weight*error;
          if(error>1e-7) worseWeight+=weight;
          maxErrorSeconds=Math.max(maxErrorSeconds,error);maxRelativeError=Math.max(maxRelativeError,b[0]>0?error/b[0]:0);
          errors.push({error,weight});
        }
      }
    }
    const b=results.records.find(r=>r.repeat===0&&r.tile===tile&&r.variant==='wasm');
    const c=results.records.find(r=>r.repeat===0&&r.tile===tile&&r.variant===variant);
    totalRevenue+=b.dailyRevenue;candidateRevenue+=c.dailyRevenue;
    for(const key of new Set([...Object.keys(b.ridershipByRoute),...Object.keys(c.ridershipByRoute)])) {
      const item=perRoute[key]??={baseline:0,candidate:0}; item.baseline+=b.ridershipByRoute[key]??0;item.candidate+=c.ridershipByRoute[key]??0;
    }
  }
  errors.sort((a,b)=>a.error-b.error);
  const errorWeight=errors.reduce((a,x)=>a+x.weight,0);
  const quantile=p=>{let acc=0;for(const x of errors){acc+=x.weight;if(acc>=errorWeight*p)return x.error;}return 0;};
  approximations.push({variant,totalDirectionalPopulation:totalWeight,changedMetricsPopulationPercent:100*changedWeight/totalWeight,
    worseCostPopulationPercent:100*worseWeight/totalWeight,transitTimeNullnessChanges:unavailableChanges,
    meanPositiveCostErrorSeconds:weightedPositiveSeconds/errorWeight,p95PositiveCostErrorSeconds:quantile(.95),p99PositiveCostErrorSeconds:quantile(.99),maxErrorSeconds,maxRelativeErrorPercent:100*maxRelativeError,
    dailyRevenueChangePercent:100*(candidateRevenue-totalRevenue)/totalRevenue,
    transitShareChangePercentagePoints:100*((modes.candidate.transit??0)-(modes.baseline.transit??0))/totalWeight,
    largestRouteChanges:Object.entries(perRoute).map(([route,v])=>({route,...v,change:v.candidate-v.baseline,changePercent:v.baseline?100*(v.candidate-v.baseline)/v.baseline:null})).sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)).slice(0,10)});
}
const summary={source:directory,complete:results.complete,baselineVariant,heapMiB:results.heapMiB??768,semiMiB:results.semiMiB??null,rows,approximations,
  approximationMetricsCollected:results.collectedMetrics===true};
await writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
