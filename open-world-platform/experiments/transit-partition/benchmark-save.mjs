// Read-only replay of a native save's network against installed demand. Each
// measurement uses a fresh worker; it never loads a save into the game, writes
// to the source save, or changes a mod.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';
import { createNetworkProfile, createCrossTileRoutingCache } from '../../src/runtime/cross-tile-mode-choice.js';
import { evaluateOffTileNativeDemand, projectOffTileNativeDemandTransferInput } from '../../src/runtime/off-tile-native-demand.js';
import { NATIVE_DEMAND_WORKER_CACHE_LIMITS } from '../../src/runtime/native-demand-worker-job.js';
import { createWasmTransitSearch } from '../commute-wasm/transit-search.js';
import { createPartitionIndex, PARTITION_EXPERIMENT_VERSION } from './partition-index.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const replacer = (key, value) => ['routingStats', 'contextKey', 'evaluationKey'].includes(key) ? undefined : value instanceof Map ? [...value] : value;

if (!isMainThread) {
  const { variant, input, outputFile } = workerData;
  const partition = variant.startsWith('partition') ? createPartitionIndex({ cellSize: Number(variant.split('-')[2]) }) : null;
  const bytes = variant === 'javascript' ? null : await readFile(new URL(partition ? './transit-search.wasm' : '../commute-wasm/transit-search.wasm', import.meta.url));
  const start = performance.now();
  const searchKernel = bytes ? createWasmTransitSearch(bytes, { partition, partitionMode: variant.includes('astar') ? 2 : 1 }) : null;
  const routingCache = createCrossTileRoutingCache({ ...NATIVE_DEMAND_WORKER_CACHE_LIMITS, searchKernel });
  const value = evaluateOffTileNativeDemand({ ...input, routingCache });
  const milliseconds = performance.now() - start;
  const serialized = JSON.stringify(value, replacer);
  if (outputFile) await writeFile(outputFile, serialized);
  parentPort.postMessage({ variant, milliseconds, hash: hash(serialized), evaluatedPops: value.profile.evaluatedPops,
    transitViablePops: value.profile.transitViablePops, assignments: value.assignments?.length,
    routingStats: value.profile.routingStats, partition: partition?.stats ?? null });
} else {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const at = arg.indexOf('='); if (!arg.startsWith('--') || at < 0) throw new Error('Use --name=value arguments');
    return [arg.slice(2, at), arg.slice(at + 1)];
  }));
  if (!args.save || !args['data-root'] || !args.output) throw new Error('Required: --save=file.metro --data-root=installed/cities/data --output=result.json');
  if (path.resolve(args.save) === path.resolve(args.output)) throw new Error('Output must not overwrite the Native Save');
  const saveBytes = await readFile(args.save);
  if (saveBytes.subarray(0, 4).toString() !== 'METR') throw new Error('Not a native METR save');
  const compressed = saveBytes.subarray(saveBytes.readUInt32LE(24), saveBytes.readUInt32LE(24) + saveBytes.readUInt32LE(28));
  if (crc32(compressed) !== saveBytes.readUInt32LE(912)) throw new Error('Save payload checksum mismatch');
  let save = JSON.parse(gunzipSync(compressed)).mainSave;
  if (!save?.cityCode?.startsWith('JP_')) throw new Error('Expected a Japan save');
  const tileIds = (args.tiles ?? save.cityCode).split(',');
  const variants = (args.variants ?? 'javascript,wasm,partition-prune-32').split(',');
  const validVariant = /^(javascript|wasm|partition-(prune|astar)-[1-9]\d*)$/;
  if (variants.some(variant => !validVariant.test(variant))) throw new Error('Unknown variant');
  const repeats = Number(args.repeats ?? 3), limit = Number(args.limit ?? 0);
  if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(limit) || limit < 0) throw new Error('Invalid repeat/limit');
  const driveAccess = args['drive-access'] === 'true';
  const sourceHash = hash(saveBytes);
  const metadata = { version: PARTITION_EXPERIMENT_VERSION, capturedAt: new Date().toISOString(),
    save: { filename: path.basename(args.save), sha256: sourceHash, timestamp: save.timestamp, city: save.cityCode,
      stations: save.data.stations.length, routes: save.data.routes.length, trains: save.data.trains.length, elapsedSeconds: save.data.timeConfig.elapsedSeconds },
    runtime: { node: process.version, cpu: os.cpus()[0]?.model, platform: process.platform },
    settings: { driveAccess, rules: 'platform defaults except explicit DRIVE_TO_STATION_ACCESS', repeats, limit,
      timing: 'fresh worker, kernel creation + full native demand evaluator; excludes save/demand read, dispatch and output hashing',
      nativeCacheLimits: NATIVE_DEMAND_WORKER_CACHE_LIMITS }, demand: [] };
  // The v2 save keeps departure seconds at p[1] and p[2]; demand geometry,
  // population sizes and driving metrics remain owned by the Tile Package.
  const departures = new Map((save.data.compressedDemandData?.v === 2 ? save.data.compressedDemandData.p : [])
    .map(row => [row[0], { homeDepartureTime: row[1], workDepartureTime: row[2] }]));
  const inputs = [];
  for (const tileId of tileIds) {
    const bytes = await readFile(path.join(args['data-root'], tileId, 'demand_data.json.gz'));
    const demand = JSON.parse(gunzipSync(bytes));
    const fullPops = demand.pops.length;
    if (limit && limit < fullPops) demand.pops = Array.from({ length: limit }, (_, i) => demand.pops[Math.floor(i * fullPops / limit)]);
    let restoredDepartures = 0;
    for (const pop of demand.pops) {
      const times = departures.get(pop.id);
      if (times && Number.isFinite(times.homeDepartureTime) && Number.isFinite(times.workDepartureTime)) {
        Object.assign(pop, times); restoredDepartures++;
      }
    }
    const networkProfile = createNetworkProfile({ tileId, ...save.data, pathfindingRules: { DRIVE_TO_STATION_ACCESS: driveAccess } });
    inputs.push(projectOffTileNativeDemandTransferInput({ worldId: 'partition-save-benchmark', tileId, demand, networkProfile,
      includeAssignments: true, globalNativeState: save.data, farePolicy: { fare: save.data.transitCost ?? 0 } }));
    metadata.demand.push({ tileId, sha256: hash(bytes), fullPops, sampledPops: demand.pops.length, restoredDepartures,
      primaryRoutes: networkProfile.routes.length });
  }
  save = null;
  await mkdir(path.dirname(args.output), { recursive: true });
  const records = [], baselines = new Map();
  for (let repeat = 0; repeat < repeats; repeat++) {
    // Rotate variant order to distribute process/JIT/system drift.
    const ordered = variants.slice(repeat % variants.length).concat(variants.slice(0, repeat % variants.length));
    for (const input of inputs) for (const variant of ordered) {
      const outputFile = args['save-outputs'] === 'true' ? `${args.output}.${input.tileId}.${variant}.${repeat}.out.json` : null;
      const row = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { input, variant, outputFile }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
        let result;
        worker.on('message', value => { result = value; });
        worker.on('error', reject);
        worker.on('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`Worker ${variant} exited ${code}`)));
      });
      if (variant === 'javascript' && !baselines.has(input.tileId)) baselines.set(input.tileId, row.hash);
      records.push({ repeat, tileId: input.tileId, ...row });
      for (const record of records) record.parity = baselines.has(record.tileId) ? record.hash === baselines.get(record.tileId) : null;
      console.log(JSON.stringify({ repeat, tile: input.tileId, variant, seconds: +(row.milliseconds / 1000).toFixed(3),
        parity: records.at(-1).parity, pruned: row.partition?.prunedStates, preparationMs: row.partition?.preprocessingMs }));
      await writeFile(args.output, JSON.stringify({ ...metadata, complete: false, records }, null, 2));
    }
  }
  if (hash(await readFile(args.save)) !== sourceHash) throw new Error('Source save changed during benchmark');
  await writeFile(args.output, JSON.stringify({ ...metadata, complete: true, sourceSaveUnchanged: true,
    rejectedVariants: variants.filter(variant => variant.includes('astar')), records }, null, 2));
  if (records.some(record => record.parity === false)) process.exitCode = 2;
  console.log(`Saved ${records.length} measurements to ${args.output}; source save unchanged.`);
}
