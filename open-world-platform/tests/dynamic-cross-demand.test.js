import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { CrossDemandModel } from '../src/runtime/cross-demand-model.js';
import { CrossDemandOverlayController } from '../src/runtime/ui/cross-demand-viewer.js';
import { createOpenWorldRoutePaths } from '../src/runtime/route-path-controller.js';
import { applyModeShares, reconcileExtensionCommuteFlows, assertCommuteLedger } from '../src/runtime/cross-tile-commute-engine.js';
import { DemandExtensionStore } from '../src/runtime/demand-extension-state.js';
import { createDemandExtensionRuntime } from '../src/runtime/demand-context.js';
import { calculateCrossTileModeShares } from '../src/runtime/cross-tile-mode-choice.js';

const base = { schemaVersion: 1,
  popFields: ['id','mass','homePoint','workPoint','gateway','homeDepartureTime','workDepartureTime','drivingSeconds','drivingDistance','tripType'],
  gateways: ['g'], points: [['base-home',0,0,'A',10,0],['base-work',.02,0,'B',0,10]],
  pops: [['packaged',10,0,1,0,28800,61200,600,2000,'commute']] };
const record = (size = 4, recordKey = 'r1') => ({ tileId: 'A', extensionId: 'induced-demand', recordKey,
  payload: { endpoints: [{id:'home',location:[.001,0],tileId:'A'}, {id:'work',location:[.021,0],tileId:'B'}],
    crossPops: [{id:'owned',residenceId:'home',jobId:'work',size,homeDepartureTime:28800,
      workDepartureTime:61200,drivingSeconds:600,drivingDistance:2000}] } });
async function fixture() {
  const packages = Object.fromEntries(['A','B'].map(tileId => [tileId, { manifest:{tileId,cityCode:tileId,schemaVersion:1,dataFiles:{}},
    demand: [], crossDemand: base, commuteCatalog: {buildHash:'base',gateways:[{id:'g',capacityPerHour:100}],
      buckets:[{id:'packaged-flow',homeTileId:'A',workTileId:'B',gatewayId:'g',mass:10,travelHours:1}]} }]));
  const game = new FakeGameAdapter();
  const runtime = new WorldTileRuntime({game,tilePackages:new MemoryTilePackageAdapter(packages),
    worldState:new ModStorageWorldStateAdapter(),initialWorld:{activeTileId:'A',wallet:100,cohorts:[]}});
  await runtime.boot('cross-world','A');
  let records = [record()], key = 'cross-r1';
  runtime.demandExtensions = {crossRecords:async()=>records,crossKeyFor:()=>key};
  return {runtime,game,setRecords(value,nextKey){records=value;key=nextKey;}};
}

test('selected extension cohorts join packaged cross demand exactly once from either Tile View', async () => {
  const f = await fixture();
  const a = await f.runtime.getCrossDemand('A'), b = await f.runtime.getCrossDemand('B');
  const model = new CrossDemandModel(a);
  assert.equal(model.stats.population,14);
  assert.equal(model.stats.pops,2);
  assert.deepEqual(a.pops,b.pops);
  assert.equal(a.pops[0][0],'packaged');
  assert.notEqual(a.pops[1][0],'owned','cross view IDs must retain source ownership scope');
  assert.equal(a.points[a.pops[1][2]][4],4);
  assert.equal(a.points[a.pops[1][3]][5],4);
  assert.equal(base.points.length,2);
  assert.equal(base.pops.length,1);
});

test('new cross cohorts enter the current aggregate clock without resetting packaged positions or charging past days', async () => {
  const f = await fixture();
  f.game.native.clock = 48 * 3600;
  const result = await f.runtime.recalculateCrossTileModeShare({force:true});
  assert.equal(result.status,'recalculated');
  const dynamic = Object.values(f.runtime.world.gatewayLedger).find(entry=>entry.flow.extension);
  assert.ok(dynamic,'the native-only path currently omits saved cross cohorts');
  assert.equal(dynamic.flow.mass,4);
  assert.equal(dynamic.atHome,4);
  assert.equal(f.runtime.world.commuteLastProcessedHour,48);
  assert.equal(f.runtime.world.crossTileFinancials.fareRevenue,0);
  assert.equal(f.runtime.world.gatewayLedger['packaged-flow'].flow.mass,10);
});

test('open cross viewer refreshes checkpoint cohorts and retires removed trip selection', async () => {
  const f = await fixture();
  const viewer = new CrossDemandOverlayController({api:{},runtime:f.runtime,tilePackages:f.runtime.tilePackages});
  await viewer.open();
  assert.equal(viewer.model.stats.population,14);
  viewer.selectPop(1);
  assert.equal(viewer.popDetails().mass,4);
  f.setRecords([], 'older-empty');
  f.runtime.invalidateCrossDemand();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(viewer.model.stats.population,10);
  assert.equal(viewer.snapshot().selectedPopIndex,null);
  viewer.dispose();
});

test('induced cross routes resolve selected checkpoint endpoints beside stored packaged routes', async () => {
  const f = await fixture(), data = await f.runtime.getCrossDemand('A');
  const calls = [], paths = createOpenWorldRoutePaths({runtime:f.runtime,tilePackages:f.runtime.tilePackages,
    tileCatalog:{tiles:[{id:'A',neighbors:['B']},{id:'B',neighbors:['A']}]},crossPopPrefixes:['packaged'],
    storedRouteLoader:async()=>({origin:[0,0],destination:[.02,0],polyline:'??AA',source:'stored-osrm'}),
    routeTiles:async request=>{calls.push(request);return {status:'routed',route:{coordinates:[request.origin,request.destination]}};}});
  const id = data.pops[1][0];
  assert.equal(paths.owns('A',id),true);
  const route = await paths.resolve('A',id);
  assert.deepEqual(route.coordinates,[[.001,0],[.021,0]]);
  assert.equal(calls.length,1);
  assert.equal((await paths.resolve('A','packaged')).source,'stored-osrm');
  f.setRecords([], 'older-empty');
  assert.equal(paths.owns('A',id),false);
  assert.equal(await paths.resolve('A',id),null);
  paths.dispose();
});

test('a late older route catalog cannot replace the current endpoint index', async () => {
  const f = await fixture();
  await f.runtime.getCrossDemand('A');
  let enter, finish, first = true;
  const entered = new Promise(resolve=>{enter=resolve;}), held = new Promise(resolve=>{finish=resolve;});
  const paths = createOpenWorldRoutePaths({runtime:f.runtime,tilePackages:f.runtime.tilePackages,
    tileCatalog:{tiles:[{id:'A',neighbors:['B']},{id:'B',neighbors:['A']}]},
    getCrossDemand:async tileId=>{const data=await f.runtime.getCrossDemand(tileId);if(first){first=false;enter();await held;}return data;},
    routeTiles:async request=>({status:'routed',route:{coordinates:[request.origin,request.destination]}})});
  const id = (await f.runtime.getCrossDemand('A')).pops[1][0];
  const older = paths.resolve('A',id); await entered;
  const next = record(5,'r2'); next.payload.endpoints[0].location=[.004,0];
  next.payload.crossPops.push({...next.payload.crossPops[0],id:'second',size:1});
  f.setRecords([next], 'cross-r2');
  const newerData = await f.runtime.getCrossDemand('A');
  assert.deepEqual((await paths.resolve('A',id)).coordinates[0],[.004,0]);
  finish(); assert.equal(await older,null);
  const second = await paths.resolve('A',newerData.pops[2][0]);
  assert.deepEqual(second?.coordinates[0],[.004,0]);
  paths.dispose();
});

for (const reason of ['hourly','cached-simulation']) test(`virtual cross fares settle once with ${reason} clock ownership`, async () => {
  const f = await fixture();
  await f.runtime.recalculateCrossTileModeShare({force:true});
  const data = await f.runtime.getCrossDemand('A'), popId = data.pops[1][0];
  const flow = data.extensionFlows[0], key = `${flow.homeTileId}|${flow.workTileId}|${flow.gatewayId}`;
  applyModeShares(f.runtime.world,new Map([[key,{driving:0,walking:0,transit:4,unknown:0}]]),{
    popModeChoices:{[popId]:{driving:0,walking:0,transit:4,unknown:0}},
    transitJourneys:new Map([[key,[{popId,transitMass:4,totalClockSeconds:600,fare:2,
      revenueByRoute:{r:2},stationRoutes:[{routeId:'r',stationIds:['h','w']}]}]]])});
  const wallet = f.game.native.wallet;
  f.game.native.clock=7*3600;
  await f.runtime.settleCrossTileCommutes(reason);
  assert.equal(f.game.native.wallet-wallet,2920);
  assert.equal(f.runtime.world.crossTileFinancials.fareRevenue,2920);
  await f.runtime.settleCrossTileCommutes(reason);
  assert.equal(f.game.native.wallet-wallet,2920,'a repeated hour cannot replay induced fares');
  assert.equal(f.runtime.world.gatewayLedger[flow.id].toWork[0].mass,4);
});

test('shrinking and retiring dynamic flows preserves packaged positions and earned pending fares', async () => {
  const f = await fixture();
  await f.runtime.recalculateCrossTileModeShare({force:true});
  const data = await f.runtime.getCrossDemand('A'), flow = data.extensionFlows[0];
  const entry = f.runtime.world.gatewayLedger[flow.id];
  entry.atHome=0;entry.atWork=1;entry.toWork=[{mass:3,departureHour:7,arrivalHour:8}];
  const packaged = structuredClone(f.runtime.world.gatewayLedger['packaged-flow']);
  f.runtime.world.commuteLastProcessedHour=7;
  f.runtime.world.crossTileFinancials.pendingNativeRevenue=123;
  f.runtime.world.crossTileFinancials.fareRevenue=123;
  f.runtime.world.pendingCrossTileAttribution={revenueByRoute:{r:123},completedCommutes:[{popId:'earned',size:1}]};
  const financials=structuredClone(f.runtime.world.crossTileFinancials), attribution=structuredClone(f.runtime.world.pendingCrossTileAttribution);
  reconcileExtensionCommuteFlows(f.runtime.world,[{...flow,mass:2}],'smaller');
  assert.equal(entry.atWork,.5);assert.equal(entry.toWork[0].mass,1.5);
  assert.equal(f.runtime.world.commuteLastProcessedHour,7);
  assertCommuteLedger(f.runtime.world);
  reconcileExtensionCommuteFlows(f.runtime.world,[],'older-empty');
  assert.deepEqual(f.runtime.world.gatewayLedger['packaged-flow'],packaged);
  assert.equal(f.runtime.world.gatewayLedger[flow.id],undefined);
  assert.deepEqual(f.runtime.world.crossTileFinancials,financials);
  assert.deepEqual(f.runtime.world.pendingCrossTileAttribution,attribution);
});

test('legacy foreign intratile cohorts retain truthful owners while local cohorts cannot enter cross accounting', async () => {
  const f=await fixture(), foreign=record();foreign.payload.endpoints[0].tileId='B';
  f.setRecords([foreign],'foreign-intratile');
  const data=await f.runtime.getCrossDemand('A');
  const trip=new CrossDemandModel(data).popDetails(1);
  assert.equal(trip.home.tileId,'B');assert.equal(trip.work.tileId,'B');
  await f.runtime.recalculateCrossTileModeShare({force:true});
  assert.equal(f.runtime.world.gatewayLedger[data.extensionFlows[0].id].flow.mass,4);
  const local=record();local.payload.endpoints[1].tileId='A';f.setRecords([local],'invalid-local');
  await assert.rejects(f.runtime.getCrossDemand('A'),/local.*cross/i);
});

test('the real saved checkpoint selects older cross cohorts for the already open viewer', async () => {
  const f=await fixture(), storage=new Map();let sequence=0;
  const store=new DemandExtensionStore({storage,createId:()=>String(++sequence)});
  const payload=size=>({ledger:'{}',points:[],pops:[],...record(size).payload});
  const older=await store.commit(await store.readCheckpoint(null,'cross-world'),'A','induced-demand',payload(4),'first');
  const newer=await store.commit(older.checkpoint,'A','induced-demand',payload(9),'second');
  const state={financialHistory:{openWorldDemandCheckpoint:newer.marker},setFinancialHistory(value){this.financialHistory=value},setTimeConfig(){}};
  const context={providerId:'p',definitionId:'d',resolvedWorldId:'cross-world',tileId:'A',cityCode:'A',nativeSessionId:'s',epoch:1,demandReady:true};
  const ownership={version:1,key:'polygon-owner-v1',ownerAt:point=>point[0]<.01?'A':'B',contains:(tile,point)=>tile===(point[0]<.01?'A':'B')};
  const bridge=createDemandExtensionRuntime({storage,game:{callbacks:{getState:()=>state}},api:{gameState:{getDemandData:()=>({points:new Map(),popsMap:new Map()})}},
    readContext:()=>context,getOwnership:()=>ownership,createId:()=>String(++sequence),onError:error=>{throw error;}});
  await bridge.activate({worldId:'cross-world',tileId:'A'});f.runtime.demandExtensions=bridge;
  const viewer=new CrossDemandOverlayController({api:{},runtime:f.runtime,tilePackages:f.runtime.tilePackages});
  await viewer.open();assert.equal(viewer.model.stats.population,19);
  state.financialHistory.openWorldDemandCheckpoint=older.marker;context.epoch++;
  await bridge.activate({worldId:'cross-world',tileId:'A',nativeAuthoritativeLoad:true});
  f.runtime.invalidateCrossDemand();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(viewer.model.stats.population,14);
  assert.equal(state.financialHistory.openWorldDemandCheckpoint.key,older.marker.key);
  assert.equal((await store.readRecord(newer.recordKey)).crossPops[0].size,9,'newer immutable records remain available, but cannot override an older Native Save');
  viewer.dispose();bridge.dispose();
});

test('an extension revision changing during mode calculation cannot publish stale dynamic groups', async () => {
  const f=await fixture();let enter,finish;
  const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{finish=resolve;});
  const before=f.runtime.world.crossModeShare;
  const job=f.runtime.recalculateCrossTileModeShare({force:true,evaluateCrossModeShares:async input=>{enter();await held;return calculateCrossTileModeShares(input);}});
  await entered;f.setRecords([record(6,'r2')],'r2');finish();
  assert.equal((await job).status,'cancelled');
  assert.equal(f.runtime.world.crossModeShare,before);
  assert.equal(Object.values(f.runtime.world.gatewayLedger).some(entry=>entry.flow.extension),false);
  await f.runtime.recalculateCrossTileModeShare({force:true});
  assert.equal(Object.values(f.runtime.world.gatewayLedger).find(entry=>entry.flow.extension).flow.mass,6);
});

test('cheap cross cohorts join hourly simulation without waiting for a mode worker or reading catalogs every hour', async () => {
  const f=await fixture();let reads=0,evaluations=0;
  const read=f.runtime.demandExtensions.crossRecords;
  f.runtime.demandExtensions.crossRecords=async()=>{reads++;return read();};
  f.runtime.evaluateCrossModeShares=()=>{evaluations++;throw Error('An hourly aggregate update cannot start a mode worker');};
  assert.equal((await f.runtime.refreshCrossDemand()).status,'refreshed');
  const flow=Object.values(f.runtime.world.gatewayLedger).find(entry=>entry.flow.extension);
  assert.equal(flow.atHome,4);
  for(let hour=1;hour<=32;hour++) {
    f.game.native.clock=hour*3600;
    await f.runtime.settleCrossTileCommutes(hour%2?'hourly':'cached-simulation');
  }
  assert.equal(flow.atWork,4);
  assert.equal(reads,1);assert.equal(evaluations,0);
  f.setRecords([record(6,'r2')],'r2');
  f.game.native.clock=33*3600;await f.runtime.settleCrossTileCommutes('hourly');
  assert.equal(flow.flow.mass,6,'the hourly fallback admits committed cohorts even if the callback was missed');
  assert.equal(flow.atHome,2);assert.equal(flow.atWork,4);
  assert.equal(reads,2);assert.equal(evaluations,0);
});

test('a failed optional mode calculation cannot mark unadmitted cross cohorts current', async () => {
  const f=await fixture();
  await assert.rejects(f.runtime.recalculateCrossTileModeShare({force:true,evaluateCrossModeShares:async()=>{throw Error('mode worker failed');}}),/mode worker failed/);
  f.game.native.clock=3600;await f.runtime.settleCrossTileCommutes('hourly');
  assert.equal(Object.values(f.runtime.world.gatewayLedger).find(entry=>entry.flow.extension)?.flow.mass,4);
});

for(const superseded of [true,false]) test(`held cheap refresh ${superseded?'cancels a reload':'allows a normal readiness/revision change'}`, async()=>{
  const f=await fixture(), context={providerId:'p',resolvedWorldId:'cross-world',tileId:'A',nativeSessionId:'s',epoch:1,demandRevision:1,demandReady:true};
  let enter,finish;const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{finish=resolve;});
  const read=f.runtime.demandExtensions.crossRecords;
  f.runtime.demandExtensions.getContext=()=>({...context});
  f.runtime.demandExtensions.crossRecords=async()=>{const result=await read();enter();await held;return result;};
  const job=f.runtime.refreshCrossDemand();await entered;
  if(superseded)context.epoch++;else{context.demandReady=false;context.demandRevision++;}
  finish();assert.equal((await job).status,superseded?'cancelled':'refreshed');
  assert.equal(Object.values(f.runtime.world.gatewayLedger).find(entry=>entry.flow.extension)?.flow.mass,superseded?undefined:4);
});

test('viewer retains selected trip identity through reordering and refreshes its route without accepting the old path',async()=>{
  const f=await fixture(), routes=[];
  const viewer=new CrossDemandOverlayController({api:{},runtime:f.runtime,tilePackages:f.runtime.tilePackages,
    routePaths:{resolve(city,id){return new Promise(finish=>routes.push({id,finish}));}}});
  await viewer.open();viewer.selectPop(1);const selected=viewer.popDetails().id;
  const next=record(4,'r2');next.payload.crossPops.unshift({...next.payload.crossPops[0],id:'new',size:1});
  f.setRecords([next],'r2');f.runtime.invalidateCrossDemand();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(viewer.popDetails().id,selected);assert.equal(viewer.snapshot().selectedPopIndex,2);
  assert.equal(routes.length,2,'a preserved trip selection must request the current route');
  routes[0].finish({source:'old',coordinates:[[1,1],[2,2]]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(viewer.selectedDrivingPath,null);
  routes[1].finish({source:'new',coordinates:[[.001,0],[.021,0]]});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(viewer.selectedDrivingPath,[[.001,0],[.021,0]]);viewer.dispose();
});
