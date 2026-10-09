import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import { createSubwayBuilderHostState } from '../../../open-world-platform/testkit/subway-builder-host.js';
import { buildUltraSpeedMod } from '../../../open-world-platform/src/mod-builder/build-ultra-speed-mod.js';

test('release ZIP is self-contained and its bundled entry loads without city data or network access', async () => {
  const modRoot = await mkdtemp(path.join(tmpdir(), 'ultra-speed-release-'));
  try {
    await writeFile(path.join(modRoot, 'manifest.json'), await readFile(new URL('../manifest.json', import.meta.url)));
    const result = await buildUltraSpeedMod({ modRoot });
    assert.ok(result.inputs.some(file => file.endsWith('cached-simulation.js')));
    assert.ok(!result.inputs.some(file => /worlds[\\/]|start-open-world|tile-server-health/.test(file)));
    const zip = await readFile(result.archivePath), files = new Map(); let offset = 0;
    while (zip.readUInt32LE(offset) === 0x04034b50) {
      const length = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
      const start = offset + 30 + nameLength + extra, bytes = inflateRawSync(zip.subarray(start, start + length));
      assert.equal(crc32(bytes), zip.readUInt32LE(offset + 14)); files.set(name, bytes); offset = start + length;
    }
    assert.deepEqual([...files.keys()].sort(), ['index.js', 'manifest.json']);
    assert.equal(JSON.parse(files.get('manifest.json')).id, 'gcm.ultra-speed');
    assert.deepEqual(files.get('index.js'), await readFile(path.join(result.distPath, 'index.js')));
    const panels = [], hooks = new Map(); let state = { cityCode: null, gameSessionId: null };
    const sandbox = { console, setTimeout, clearTimeout, performance, Map, TextEncoder, TextDecoder, structuredClone,
      fetch() { throw new Error('Standalone attempted network access'); },
      __subwayBuilder_storeCallbacks__: { getState: () => state },
      SubwayBuilderAPI: { hooks: new Proxy({}, { get: (_target, name) => listener => {
        const listeners = hooks.get(name) ?? new Set(); hooks.set(name, listeners); listeners.add(listener);
        return () => listeners.delete(listener);
      } }), utils: { React: { createElement() {} } },
        ui: { addToolbarPanel: panel => panels.push(panel), unregisterComponent() {} } } };
    vm.runInNewContext(files.get('index.js').toString(), sandbox);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panels.length, 1); assert.equal(sandbox.__subwayBuilderUltraSpeedModV1__.snapshot().status, 'unavailable');
    await sandbox.__subwayBuilderUltraSpeedModV1__.dispose();

    // Execute the workers embedded in the actual archive, with browser-like
    // Blob/Worker adapters. External fetch remains forbidden in both isolates.
    const scripts = new Map(), workers = [];
    sandbox.Blob = class { constructor(parts) { this.source = parts.join(''); } };
    sandbox.URL = { createObjectURL(blob) { const url = `blob:fixture-${scripts.size}`; scripts.set(url, blob.source); return url; },
      revokeObjectURL(url) { scripts.delete(url); } };
    sandbox.Worker = class {
      constructor(url, options) {
        workers.push(options?.name ?? 'finance');
        this.isolate = { console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, Uint8Array,
          crypto, CompressionStream, DecompressionStream, Blob, Response, structuredClone, fetch: sandbox.fetch };
        this.isolate.self = this.isolate;
        this.isolate.postMessage = data => queueMicrotask(() => { if (!this.closed) this.onmessage?.({ data: structuredClone(data) }); });
        vm.runInNewContext(scripts.get(url), this.isolate);
      }
      postMessage(data) { queueMicrotask(() => { if (!this.closed) Promise.resolve(this.isolate.onmessage({ data: structuredClone(data) }))
        .catch(error => this.onerror?.({ message: error.message })); }); }
      terminate() { this.closed = true; }
    };
    state = createSubwayBuilderHostState({ cityCode: 'NATIVE', gameSessionId: 'native-session', money: 10000,
      timeConfig: { elapsedSeconds: 25000, timeSpeed: 'ultrafast', paused: false },
      demandData: { points: new Map([['h', { id: 'h', location: [0, 0] }], ['w', { id: 'w', location: [0.001, 0] }]]),
        popsMap: new Map([['p', { id: 'p', size: 10, residenceId: 'h', jobId: 'w', drivingSeconds: 600, drivingDistance: 1000 }]]) },
      generateSave: () => ({ data: { elapsedSeconds: state.timeConfig.elapsedSeconds, money: state.money, trains: state.trains } }),
      loadSave() {}, setDemandData(value) { state.demandData = value; }, setTrains(value) { state.trains = value; },
      financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
      routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} } });
    Object.assign(sandbox.__subwayBuilder_storeCallbacks__, { setMoney() {}, setTicketCost() {} });
    Object.assign(sandbox.SubwayBuilderAPI, { version: '1.0.0',
      cities: { setCityDataFiles() { throw new Error('Unexpected city registration'); } }, trains: { getTrainTypes: () => [] },
      gameState: { getStations: () => state.stations, getRoutes: () => state.routes, getTrains: () => state.trains } });
    sandbox.SubwayBuilderAPI.utils.getPathfindingRules = () => ({});
    // Native reload leaves an old World lease in the renderer even when that
    // consumer is disabled. Verify the published bundle ignores that lease.
    sandbox.__openWorldUltraSpeedOwnershipV1__ = {
      worlds: new Map([['local.world', { cities: new Set(['OTHER_CITY']) }]]), listeners: new Set() };
    let loadedMods = [];
    sandbox.SubwayBuilderAPI.mods = { getLoadedMods: () => loadedMods };
    sandbox.window = new EventTarget();
    vm.runInNewContext(files.get('index.js').toString(), sandbox);
    await new Promise(resolve => setImmediate(resolve));
    const mod = sandbox.__subwayBuilderUltraSpeedModV1__;
    try {
      await mod.whenIdle(); await mod.setEnabled(true);
      assert.equal(mod.snapshot().error, null); assert.equal(mod.snapshot().status, 'ready');
      assert.equal(mod.snapshot().assignedPops, 1);
      assert.ok(workers.includes('open-world-native-demand-worker-evaluator-v4-bounded'));
      assert.ok(workers.includes('finance'));
      await state.handleIncrementGameState(); assert.equal(state.timeConfig.elapsedSeconds, 25240);
      assert.equal(state.generateSave().data.elapsedSeconds, 25240);
      loadedMods = [{ id: 'local.world', name: 'Test Open World' }];
      sandbox.window.dispatchEvent(new Event('modding-api-reload-complete'));
      await mod.whenIdle();
      assert.equal(mod.snapshot().status, 'open-world');
      assert.equal(mod.snapshot().worldOwner, 'local.world');
      loadedMods = [];
      sandbox.window.dispatchEvent(new Event('modding-api-reload-complete'));
      await mod.whenIdle();
      assert.equal(mod.snapshot().status, 'ready');
      assert.equal(mod.snapshot().worldOwner, null);
      assert.equal(mod.snapshot().version, 'ultra-speed-standalone-v4-capacity');
      // Native hot reload replays these in this order, without onGameLoaded
      // when the playable city is a fresh game rather than a loaded save.
      for (const name of ['onMapReady', 'onGameInit', 'onCityLoad']) {
        for (const listener of hooks.get(name) ?? []) listener();
      }
      sandbox.window.dispatchEvent(new Event('modding-api-reload-complete'));
      await mod.whenIdle();
      assert.equal(mod.snapshot().status, 'ready');
      const before = state.timeConfig.elapsedSeconds;
      await state.handleIncrementGameState();
      assert.equal(state.timeConfig.elapsedSeconds, before + 240);
      // Exercise capacity through the actual ZIP entry and embedded demand worker.
      await mod.setEnabled(false);
      state.stations = [{ id: 'A', coords: [0,0], buildType: 'constructed', stNodeIds: ['a'] },
        { id: 'B', coords: [0.1,0], buildType: 'constructed', stNodeIds: ['b'] }];
      state.routes = [{ id: 'R', trainType: 'fixture', carsPerTrain: 1, idealTrainCount: 1,
        stNodes: [{id:'a'},{id:'b'},{id:'a'}], stComboTimings: [
          {stNodeIndex:0,arrivalTime:0,departureTime:20},
          {stNodeIndex:1,arrivalTime:580,departureTime:600},
          {stNodeIndex:2,arrivalTime:1180,departureTime:1200} ] }];
      sandbox.SubwayBuilderAPI.trains.getTrainTypes = () => [{id:'fixture',stats:{capacityPerCar:50,carsPerCarSet:1}}];
      state.demandData = { points: new Map([['h',{id:'h',location:[0,0]}],['w',{id:'w',location:[0.1,0]}]]),
        popsMap: new Map(Array.from({length:160},(_,i)=>[`P${i}`,{id:`P${i}`,size:25,residenceId:'h',jobId:'w',
          drivingSeconds:2400,drivingDistance:15000,homeDepartureTime:28800,workDepartureTime:61200}])) };
      await mod.setEnabled(true);
      assert.equal(mod.snapshot().error,null);
      assert.equal(mod.snapshot().assignedPops,160);
      assert.equal(mod.snapshot().capacity.version,'scheduled-segment-capacity-v1');
      assert.ok(mod.snapshot().dailyRidership < 1000);
      assert.ok(mod.snapshot().capacity.unservedPeople > 0);
      assert.equal(mod.snapshot().dailyRidership,mod.snapshot().capacity.carriedPeople);
      const small = mod.snapshot().dailyRidership;
      await mod.setEnabled(false);
      state.routes = [{...state.routes[0],carsPerTrain:10}];
      await mod.setEnabled(true);
      assert.ok(mod.snapshot().dailyRidership > small,'published worker responds to larger consists');
    } finally { await mod.dispose(); }

  } finally { await rm(modRoot, { recursive: true, force: true }); }
});
