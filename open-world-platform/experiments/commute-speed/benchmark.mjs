// Isolated, bounded-process replay. No production module, save or game is modified.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import inspector from 'node:inspector';
import { promisify } from 'node:util';
import { build } from '../../node_modules/esbuild/lib/main.js';
import { createNetworkProfile } from '../../src/runtime/cross-tile-mode-choice.js';
import { projectOffTileNativeDemandTransferInput } from '../../src/runtime/off-tile-native-demand.js';
import { createWasmTransitSearch } from '../commute-wasm/transit-search.js';
import { createPartitionIndex } from '../transit-partition/partition-index.js';

const experiment = fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(experiment, '../../..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); if (at < 0 || !arg.startsWith('--')) throw Error('Use --name=value');
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
const digest = value => createHash('sha256').update(value).digest('hex');
const replacer = (key, value) => ['routingStats', 'contextKey', 'evaluationKey'].includes(key) ? undefined : value;
const runtime = path.resolve(experiment, '../../src/runtime');

async function bundle(variant, outfile) {
  const entry = `export { nativeDemandEvaluationBatches, mergeNativeDemandProfiles } from ${JSON.stringify(path.join(runtime, 'off-tile-native-demand.js'))};
export { createCrossTileRoutingCache } from ${JSON.stringify(path.join(runtime, 'cross-tile-mode-choice.js'))};`
    + (variant.includes('memo') ? `export { withEvaluationMemo } from ${JSON.stringify(path.join(experiment, 'memoization.js'))};` : '');
  await build({ stdin: { contents: entry, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'experiment-only-substitutions', setup(api) {
      api.onLoad({ filter: /[\\/]src[\\/]runtime[\\/](cross-tile-mode-choice|off-tile-native-demand|journey-fare)\.js$/ }, async info => {
        let contents = await readFile(info.path, 'utf8');
        if (variant.includes('aggregate') && info.path.endsWith('off-tile-native-demand.js')) {
          const begin = contents.indexOf('export function mergeNativeDemandProfiles(');
          const end = contents.indexOf('export function evaluateOffTileNativeDemand(', begin);
          if (begin < 0 || end < 0) throw Error('Aggregation substitution seam changed');
          contents = `import { createIncrementalNativeDemandProfileMerger } from ${JSON.stringify(path.join(experiment, 'aggregation.js'))};\n`
            + contents.slice(0, begin) + 'export const mergeNativeDemandProfiles = createIncrementalNativeDemandProfileMerger();\n\n' + contents.slice(end);
        }
        if (variant.includes('modes') && info.path.endsWith('cross-tile-mode-choice.js')) {
          const begin = contents.indexOf('function chooseModesFromMetrics(');
          const end = contents.indexOf('function modeChoiceMetrics(', begin);
          if (begin < 0 || end < 0) throw Error('Mode substitution seam changed');
          contents = `import { createFastModeChooser } from ${JSON.stringify(path.join(experiment, 'mode-choice.js'))};\n`
            + contents.slice(0, begin) + `const fastModeChooser = createFastModeChooser({ incomeValueAt: (i,n,rules) => incomeForPerson(i,n,rules) / rules.HOURS_WORKED_PER_YEAR / 3600 });
function chooseModesFromMetrics(population,rules,metrics) { return fastModeChooser.choose(population,rules,metrics); }\n\n` + contents.slice(end);
        }
        if (variant.includes('memo') && info.path.endsWith('cross-tile-mode-choice.js')) {
          const seam = 'const key = JSON.stringify(Object.entries(networkProfiles ?? {}).filter(([,p])=>p).sort(([a],[b])=>a.localeCompare(b)));';
          if (!contents.includes(seam)) throw Error('Graph key substitution seam changed');
          contents = `import { evaluationGraphKey } from ${JSON.stringify(path.join(experiment, 'memoization.js'))};\n`
            + contents.replace(seam, 'const key = evaluationGraphKey(networkProfiles);');
        }
        if (variant.includes('memo') && info.path.endsWith('journey-fare.js')) {
          if (!contents.includes('function fareIndex(')) throw Error('Fare substitution seam changed');
          contents = `import { evaluationFareIndex } from ${JSON.stringify(path.join(experiment, 'memoization.js'))};\n`
            + contents.replace('function fareIndex(', 'function uncachedFareIndex(')
            + '\nfunction fareIndex(groups,routes,legacyFare) { return evaluationFareIndex(groups,routes,legacyFare,uncachedFareIndex); }\n';
        }
        return { contents, loader: 'js', resolveDir: path.dirname(info.path) };
      });
    } }] });
}

if (args.worker === 'true') {
  const api = await import(pathToFileURL(args.bundle));
  const input = JSON.parse(await readFile(args.input, 'utf8'));
  const partition = args.variant.includes('partition') ? createPartitionIndex({cellSize:32}) : null;
  const wasm = await readFile(new URL(partition ? '../transit-partition/transit-search.wasm' : '../commute-wasm/transit-search.wasm', import.meta.url));
  let kernel = createWasmTransitSearch(wasm, { partition, partitionMode: 1 });
  if (args.variant.includes('reuse')) {
    const { createRouteReuseSearch } = await import('./route-reuse.js');
    kernel = createRouteReuseSearch(kernel);
  }
  const cache = api.createCrossTileRoutingCache({ maxSearchLabels: 8000, maxPaths: 1024, maxCatchments: 4096, searchKernel: kernel });
  global.gc?.();
  let peak = process.memoryUsage();
  const sample = () => { const now = process.memoryUsage(); for (const key of Object.keys(now)) peak[key] = Math.max(peak[key], now[key]); };
  const startMemory = process.memoryUsage();
  let session, post;
  if (args.profile === 'true') {
    session = new inspector.Session(); session.connect(); post = promisify(session.post).bind(session);
    await post('Profiler.enable'); await post('Profiler.start');
  }
  const assignmentHash = createHash('sha256');
  let profile = null, batches = 0, assignments = 0, observerMs = 0;
  const metrics = args.metrics === 'true' ? [] : null;
  const started = performance.now();
  const evaluate = () => { for (const batch of api.nativeDemandEvaluationBatches({ ...input, routingCache: cache })) {
    profile = api.mergeNativeDemandProfiles(profile, batch.profile);
    const observing = performance.now();
    for (const row of batch.assignments ?? []) {
      assignmentHash.update(JSON.stringify(row)); assignmentHash.update('\n'); assignments++;
      if (metrics) metrics.push([row.id, ...['homeToWork', 'workToHome'].map(direction => {
        const c = row.commutes[direction];
        return [c.transitTime, c.transitCost, c.modeChoice, c.transitPaths[0]?.totalTime ?? null];
      })]);
    }
    sample(); observerMs += performance.now() - observing; batches++;
  } };
  let memoStats = null;
  if (api.withEvaluationMemo) api.withEvaluationMemo(memo => { evaluate(); memoStats = { ...memo.stats }; });
  else evaluate();
  // Force any lazy experiment aggregations to materialize inside measured work.
  api.mergeNativeDemandProfiles.finalize?.(profile);
  const profileString = JSON.stringify(profile, replacer);
  const milliseconds = performance.now() - started - observerMs;
  sample();
  if (session) {
    const { profile: cpu } = await post('Profiler.stop'); session.disconnect();
    await writeFile(args.result + '.cpuprofile', JSON.stringify(cpu));
    const counts = new Map(); for (let i = 0; i < cpu.samples.length; i++) counts.set(cpu.samples[i], (counts.get(cpu.samples[i]) ?? 0) + cpu.timeDeltas[i]);
    const top = cpu.nodes.map(n => ({ fn: n.callFrame.functionName || '(anonymous)', url: n.callFrame.url, line: n.callFrame.lineNumber + 1, milliseconds: (counts.get(n.id) ?? 0) / 1000 })).sort((a,b) => b.milliseconds-a.milliseconds).slice(0, 25);
    await writeFile(args.result + '.profile-summary.json', JSON.stringify(top, null, 2));
  }
  const record = { variant: args.variant, tile: input.tileId, milliseconds, observerMs, profiled: Boolean(session), collectedMetrics: Boolean(metrics), batches, assignments,
    assignmentHash: assignmentHash.digest('hex'), profileHash: digest(profileString),
    dailyRevenue: profile.dailyRevenue, transitPopulation: profile.transitPopulation,
    modeChoicePopulation: profile.modeChoicePopulation, ridershipByRoute: profile.ridershipByRoute,
    routingStats: profile.routingStats, kernelStats: kernel.stats ?? null, partitionStats: partition?.stats ?? null, aggregationStats: api.mergeNativeDemandProfiles.stats ?? null, memoStats,
    wasmSha256: digest(wasm),
    memory: { start: startMemory, sampledPeak: peak, processMaxRssKiB: process.resourceUsage().maxRSS,
      scope: 'one isolated process; peak RSS includes input load; heap samples between batches can miss transient peaks' } };
  await writeFile(args.result, JSON.stringify(record, null, 2));
  if (metrics) await writeFile(args.result + '.metrics.json', JSON.stringify(metrics));
  console.log(JSON.stringify({ variant: record.variant, tile: record.tile, seconds: +(milliseconds / 1000).toFixed(3), rssMiB: +(peak.rss / 2**20).toFixed(1), heapMiB: +(peak.heapUsed / 2**20).toFixed(1) }));
} else {
  const directory = path.resolve(args.output ?? '.analysis/commute-speed');
  await mkdir(directory, { recursive: true });
  const savePath = path.resolve(args.save ?? '.analysis/transit-partition-inputs/network.metro');
  const saveBytes = await readFile(savePath), saveHash = digest(saveBytes);
  if (saveBytes.subarray(0,4).toString() !== 'METR') throw Error('Expected native save');
  const compressed = saveBytes.subarray(saveBytes.readUInt32LE(24), saveBytes.readUInt32LE(24)+saveBytes.readUInt32LE(28));
  if (crc32(compressed) !== saveBytes.readUInt32LE(912)) throw Error('Save CRC mismatch');
  let save = JSON.parse(gunzipSync(compressed)).mainSave;
  const departures = new Map((save.data.compressedDemandData?.v === 2 ? save.data.compressedDemandData.p : []).map(row => [row[0], [row[1],row[2]]]));
  const tiles = (args.tiles ?? 'JP_PREF_12,JP_TOKYO_MAINLAND,JP_KANAGAWA_MAINLAND').split(',');
  const variants = (args.variants ?? 'wasm').split(',');
  if (variants.some(value => !/^wasm(?:-(?:aggregate|modes|reuse|memo|partition))*$/.test(value))) throw Error('Unknown experiment variant');
  const limit = Number(args.limit ?? 0), repeats = Number(args.repeats ?? 1), heapMiB = Number(args['heap-mib'] ?? 768), semiMiB = Number(args['semi-mib'] ?? 8);
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(repeats) || repeats < 1) throw Error('Invalid limit/repeats');
  if (!Number.isInteger(heapMiB) || heapMiB < 128 || heapMiB > 2048) throw Error('Heap limit must be 128–2048 MiB');
  if (!Number.isInteger(semiMiB) || semiMiB < 1 || semiMiB > 64) throw Error('Semi-space size must be 1–64 MiB');
  const meta = { version: 'commute-speed-memory-v1', capturedAt: new Date().toISOString(), save: { name: path.basename(savePath), sha256: saveHash, stations: save.data.stations.length, routes: save.data.routes.length, city: save.cityCode },
    runtime: { cpu: os.cpus()[0].model, node: process.version }, limit, repeats, tiles, variants, heapMiB, semiMiB,
    collectedMetrics: args.metrics === 'true', profiled: args.profile === 'true', driveToStationAccess: args.drive === 'true', demand: [], bundleHashes: {},
    wasmSha256: digest(await readFile(new URL('../commute-wasm/transit-search.wasm', import.meta.url))),
    timing: 'fresh heap-capped process, streamed assignments, full evaluator + final profile serialization; excludes input decode and assignment hashing; no parallel benchmark processes', records: [] };
  for (const tile of tiles) {
    const bytes = await readFile(path.resolve(args['data-root'] ?? '.analysis/transit-partition-inputs/cities', tile, 'demand_data.json.gz'));
    const demand = JSON.parse(gunzipSync(bytes));
    const fullPops = demand.pops.length;
    if (limit && limit < demand.pops.length) { const all = demand.pops; demand.pops = Array.from({length:limit}, (_,i) => all[Math.floor(i*all.length/limit)]); }
    for (const p of demand.pops) { const times = departures.get(p.id); if (times) { p.homeDepartureTime=times[0]; p.workDepartureTime=times[1]; } }
    const input = projectOffTileNativeDemandTransferInput({ worldId:'commute-speed-replay', tileId:tile, demand,
      networkProfile:createNetworkProfile({tileId:tile,...save.data,pathfindingRules:{ DRIVE_TO_STATION_ACCESS: args.drive === 'true' }}),
      includeAssignments:true, globalNativeState:save.data, farePolicy:{fare:save.data.transitCost ?? 0} });
    const serializedInput=JSON.stringify(input);
    await writeFile(path.join(directory, tile+'.input.json'), serializedInput);
    meta.demand.push({tile, sha256:digest(bytes), inputSha256:digest(serializedInput), fullPops, evaluatedPops:demand.pops.length});
  }
  save=null; departures.clear(); global.gc?.();
  for (const variant of variants) {
    const filename=path.join(directory, variant+'.bundle.mjs');
    await bundle(variant, filename); meta.bundleHashes[variant]=digest(await readFile(filename));
  }
  for (let repeat=0; repeat<repeats; repeat++) for (const tile of tiles) {
    const ordered=variants.slice(repeat%variants.length).concat(variants.slice(0,repeat%variants.length));
    for (const variant of ordered) {
      const result=path.join(directory, `${tile}.${variant}.${repeat}.json`);
      await new Promise((resolve,reject) => {
        const child=spawn(process.execPath,['--expose-gc',`--max-old-space-size=${heapMiB}`,`--max-semi-space-size=${semiMiB}`,fileURLToPath(import.meta.url),'--worker=true',`--variant=${variant}`,`--input=${path.join(directory,tile+'.input.json')}`,`--bundle=${path.join(directory,variant+'.bundle.mjs')}`,`--result=${result}`,`--profile=${args.profile ?? 'false'}`,`--metrics=${args.metrics ?? 'false'}`],{stdio:'inherit',windowsHide:true});
        child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(Error(`Experiment child failed: ${variant} ${code}`)));
      });
      meta.records.push({repeat,...JSON.parse(await readFile(result,'utf8'))});
      await writeFile(path.join(directory,'results.json'),JSON.stringify(meta,null,2));
    }
  }
  meta.sourceSaveUnchanged=digest(await readFile(savePath))===saveHash;
  if (!meta.sourceSaveUnchanged) throw Error('Source save changed');
  meta.comparisonBaseline=variants.includes('wasm')?'wasm':variants[0];
  for(const row of meta.records) {
    const baseline=meta.records.find(b=>b.variant===meta.comparisonBaseline&&b.tile===row.tile&&b.repeat===row.repeat);
    row.assignmentParity=row.assignmentHash===baseline.assignmentHash;
    row.profileParity=row.profileHash===baseline.profileHash;
  }
  meta.complete=true;
  await writeFile(path.join(directory,'results.json'),JSON.stringify(meta,null,2));
  if(meta.records.some(row=>!row.variant.includes('reuse')&&(!row.assignmentParity||!row.profileParity))) process.exitCode=2;
}
