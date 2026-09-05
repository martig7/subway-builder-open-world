import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkProfile, inspectCrossTileModeChoice } from '../src/runtime/cross-tile-mode-choice.js';
import { evaluateOffTileNativeDemand, offTileNativeDemandContextKey } from '../src/runtime/off-tile-native-demand.js';
import { readDriveToStationAccess } from '../src/runtime/native-routing-settings.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { NativeRevenueAccrual } from '../src/runtime/native-revenue-accrual.js';

test('native drive-to-station is opt-in and reads current settings without writing', () => {
  for (const [raw, expected] of [[null,false],['{}',false],['{"DRIVE_TO_STATION_ACCESS":true}',true],['{"DRIVE_TO_STATION_ACCESS":false}',false],['{"DRIVE_TO_STATION_ACCESS":"true"}',false],['invalid',false]]) {
    assert.equal(readDriveToStationAccess({getItem:key=>{assert.equal(key,'featureFlags');return raw;}}),expected);
  }
  assert.equal(readDriveToStationAccess({getItem(){throw new Error('storage unavailable');}}),false);
  const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  let enabled=true;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify({DRIVE_TO_STATION_ACCESS:enabled})}});
  try {
    const adapter=new SubwayBuilderGameAdapter({api:{utils:{getPathfindingRules:()=>({MAX_WALK_TO_FROM_STATION:2700})}},callbacks:{}});
    assert.deepEqual(adapter.capturePathfindingRules(),{MAX_WALK_TO_FROM_STATION:2700,DRIVE_TO_STATION_ACCESS:true});
    enabled=false;
    assert.equal(adapter.capturePathfindingRules().DRIVE_TO_STATION_ACCESS,false);
  } finally { if(prior)Object.defineProperty(globalThis,'localStorage',prior);else delete globalThis.localStorage; }
});

function fixture(enabled) {
  const networkProfile = createNetworkProfile({ tileId: 'T', pathfindingRules: { DRIVE_TO_STATION_ACCESS: enabled },
    stations: [
      { id: 'A', coords: [0, 0], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'B', coords: [0.1, 0], stNodeIds: ['b'], buildType: 'constructed' },
    ],
    routes: [{ id: 'R', idealTrainCount: 4, stNodes: [{id:'a'},{id:'b'},{id:'a'}],
      stComboTimings: [{stNodeIndex:0,arrivalTime:0,departureTime:10},{stNodeIndex:1,arrivalTime:300,departureTime:310},{stNodeIndex:2,arrivalTime:600,departureTime:610}] }],
  });
  const demand = { points: [{id:'home',location:[-0.02,0]},{id:'work',location:[0.1,0]}],
    pops: [{id:'P',size:100,residenceId:'home',jobId:'work',drivingDistance:20000,drivingSeconds:2000}] };
  return {tileId:'T',networkProfile,demand,farePolicy:{fare:2.5}};
}

test('inactive demand earns drive-to-station revenue only when the feature is enabled', () => {
  const off = evaluateOffTileNativeDemand(fixture(false));
  const on = evaluateOffTileNativeDemand(fixture(true));
  assert.equal(off.profile.dailyRevenue, 0);
  assert.ok(on.profile.dailyRevenue > 0, 'native park-and-ride service must not disappear off tile');
  assert.notEqual(offTileNativeDemandContextKey(fixture(false)), offTileNativeDemandContextKey(fixture(true)));
  assert.equal(evaluateOffTileNativeDemand({...fixture(false),existingProfile:on.profile}).status, 'evaluated');
  // The outward direction is reachable by driving; the reverse direction
  // cannot walk home. Do not copy outward fare revenue into the return trip.
  assert.ok(on.profile.dailyRevenue < on.profile.transitPopulation * 2.5 * 365 * 2);
});

test('hourly recovery propagates a changed feature flag to every tile and invalidates old profiles', async () => {
  const input=fixture(false);
  const game=new FakeGameAdapter();
  let enabled=false;
  game.capturePathfindingRules=()=>({DRIVE_TO_STATION_ACCESS:enabled});
  game.native.stations=input.networkProfile.stations.map(s=>({...s,buildType:'constructed'}));
  game.native.routes=[{id:'R',idealTrainCount:4,stNodes:[{id:'a'},{id:'b'},{id:'a'}],stComboTimings:input.networkProfile.routes[0].stComboTimings}];
  game.native.trains=[];
  const packages=new MemoryTilePackageAdapter(Object.fromEntries(['T','OTHER'].map(id=>[id,{
    manifest:{tileId:id,cityCode:id,schemaVersion:1,dataFiles:{}},demand:[],nativeDemand:id==='T'?input.demand:{points:[],pops:[]},
    commuteCatalog:{buildHash:'drive-setting-test',buckets:[],gateways:[]},
  }])));
  const runtime=new WorldTileRuntime({game,tilePackages:packages,worldState:new ModStorageWorldStateAdapter({financeMode:'blind'}),
    tileCatalog:{tiles:[{id:'T'},{id:'OTHER'}]},
    revenueAccrual:new NativeRevenueAccrual({adapter:game}),backgroundNativeExpenses:false,initialWorld:{activeTileId:'OTHER',cohorts:[]}});
  await runtime.boot('drive-setting-test','OTHER');
  await runtime.recalculateCrossTileModeShare({reason:'startup'});
  assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.T.dailyRevenue,0);
  enabled=true;game.native.clock=3600;
  await runtime.settleCrossTileCommutes('hourly');
  assert.ok(runtime.world.backgroundNativeFinance.tileRevenueProfiles.T.dailyRevenue>0);
  assert.equal((await runtime.inspectNativeRevenue()).routingRules.DRIVE_TO_STATION_ACCESS,true);
  enabled=false;game.native.clock=7200;
  await runtime.settleCrossTileCommutes('hourly');
  assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.T.dailyRevenue,0);
});

test('driving access uses road speed and congestion, never driving egress or a driving-only fare', () => {
  const {networkProfile,demand}=fixture(true);
  const inspect = (seconds, reverse=false) => inspectCrossTileModeChoice({
    crossDemand:{schemaVersion:1,gateways:['local'],
      points:demand.points.map(p=>[p.id,...p.location,'T']),
      popFields:['id','mass','homeIndex','workIndex','gatewayIndex','drivingSeconds','drivingDistance','homeDepartureTime'],
      pops:[['P',100,reverse?1:0,reverse?0:1,0,seconds,20000,8*3600]],
    },popIndex:0,networkProfiles:{T:networkProfile},gatewayCatalog:{},fare:2.5,
  });
  const on=inspect(2000);
  assert.ok(on.transitPath.available);
  assert.equal(on.transitPath.continuousLeg.accessMode,'drive');
  assert.ok(on.transitPath.continuousLeg.accessDriveSeconds>0);
  assert.equal(inspect(0).transitPath.available,false,'invalid driving evidence must not invent an access speed');
  assert.equal(inspect(20000).transitPath.available,false,'slow road access exceeds the drive catchment');
  assert.equal(inspect(2000,true).transitPath.available,false,'park-and-ride does not allow driving from the final station');
});
