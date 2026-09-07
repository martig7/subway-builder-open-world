import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCrossTileModeShares, createNetworkProfile, createCrossTileRoutingCache } from '../src/runtime/cross-tile-mode-choice.js';

function fixture() {
  const profile = createNetworkProfile({tileId:'A', stations:[0,1,2,3].map(i=>({id:`s${i}`,coords:[i*0.04,0],buildType:'constructed',stNodeIds:[`n${i}`],nearbyStations:[]})),
    routes:[{id:'local',stNodes:[0,1,2,3].map(i=>({id:`n${i}`})),idealTrainCount:2}]});
  return {worldId:'test-world',networkProfiles:{A:profile},gatewayCatalog:{},fare:0,
    crossDemand:{schemaVersion:1,points:[['h',0,0,'A'],['w',0.08,0,'A'],['v',0.12,0,'A']],gateways:['local'],pops:[['p',100,0,1,0],['q',100,0,2,0]]}};
}
const outcomes = ({routingStats,...value})=>value;
const exact = input => calculateCrossTileModeShares({...input,routingCache:createCrossTileRoutingCache({enabled:false})});

test('persistent routing reuses the graph and exact searches across cloned inputs and fare changes',()=>{
  const input=fixture(), routingCache=createCrossTileRoutingCache();
  const cold=calculateCrossTileModeShares({...input,routingCache});
  const warm=calculateCrossTileModeShares({...structuredClone(input),routingCache});
  assert.deepEqual(outcomes(warm),outcomes(cold));
  assert.equal(warm.routingStats.graphBuilds,0);
  assert.equal(warm.routingStats.searches,0);
  assert.ok(cold.routingStats.sourceSearchHits>0,'one origin search serves multiple destinations');
  const fare={...input,fare:1000};
  assert.deepEqual(outcomes(calculateCrossTileModeShares({...fare,routingCache})),outcomes(calculateCrossTileModeShares(fare)));
});

test('changes to service, access coordinates, and World identity cannot return stale paths',()=>{
  const input=fixture(), routingCache=createCrossTileRoutingCache();
  calculateCrossTileModeShares({...input,routingCache});
  for(const change of ['service','coords','world']) {
    const next=structuredClone(input);
    if(change==='service') next.networkProfiles.A.routes[0].serviceCount=10;
    if(change==='coords') next.crossDemand.points[0][1]=0.006;
    if(change==='world') next.worldId='other';
    assert.deepEqual(outcomes(calculateCrossTileModeShares({...next,routingCache})),outcomes(calculateCrossTileModeShares(next)));
  }
});

test('directed connectivity rejects unreachable journeys without a routing search',()=>{
  const input=fixture();
  input.networkProfiles.A.routes=[];
  input.networkProfiles.A.activeRouteIds=[];
  const result=calculateCrossTileModeShares(input);
  assert.equal(result.transitViablePops,0);
  assert.equal(result.routingStats.searches,0);
  assert.ok(result.routingStats.connectivityRejects>0);
});

test('endpoint cache rechecks the optimum when a passenger misses the formerly best departure',()=>{
  const input=fixture();
  const p=input.networkProfiles.A;
  p.stations=p.stations.slice(0,2);
  p.routes=[
    {id:'early',stNodeIds:['n0','n1'],serviceCount:1,stComboTimings:[{stNodeIndex:0,arrivalTime:0,departureTime:100},{stNodeIndex:1,arrivalTime:200,departureTime:1000}]},
    {id:'later',stNodeIds:['n0','n1'],serviceCount:1,stComboTimings:[{stNodeIndex:0,arrivalTime:0,departureTime:250},{stNodeIndex:1,arrivalTime:300,departureTime:1000}]},
  ];
  p.activeRouteIds=['early','later'];
  input.tileCatalog={tiles:[{id:'A',bounds:[-0.04,-0.02,0.04,0.02],neighbors:[{tileId:'B'}]},{id:'B',bounds:[0.04,-0.02,0.12,0.02],neighbors:[{tileId:'A'}]}]};
  input.crossDemand.points=[['h',0,0,'A'],['w',0.04,0,'B']];
  input.crossDemand.popFields=['id','mass','home','work','gateway','homeDepartureTime'];
  input.crossDemand.pops=[['early-pop',100,0,1,0,0],['late-pop',100,0,1,0,100]];
  const both=calculateCrossTileModeShares(input);
  const single=calculateCrossTileModeShares({...input,crossDemand:{...input.crossDemand,pops:[input.crossDemand.pops[1]]}});
  assert.deepEqual(both.popModeChoices['late-pop'],single.popModeChoices['late-pop']);
  const journey=result=>[...result.transitJourneys.values()].flat().find(j=>j.popId==='late-pop');
  assert.deepEqual(journey(both),journey(single));
});

test('an unrelated component edit preserves searches, but a new faster alternative invalidates them',()=>{
  const input=fixture(), routingCache=createCrossTileRoutingCache();
  const remote=createNetworkProfile({tileId:'Z',stations:[0,1].map(i=>({id:`z${i}`,coords:[10+i*0.05,0],stNodeIds:[`zn${i}`],buildType:'constructed',nearbyStations:[]})),
    routes:[{id:'remote',stNodes:[{id:'zn0'},{id:'zn1'}],idealTrainCount:1}]});
  input.networkProfiles.Z=remote;
  calculateCrossTileModeShares({...input,routingCache});
  const changed=structuredClone(input);
  changed.networkProfiles.Z.routes[0].serviceCount=8;
  const unaffected=calculateCrossTileModeShares({...changed,routingCache});
  assert.deepEqual(outcomes(unaffected),outcomes(exact(changed)));
  assert.equal(unaffected.routingStats.searches,0);
  assert.equal(unaffected.routingStats.exactPathHits,2);
  assert.equal(unaffected.routingStats.spatialIndexHits,1);
  assert.equal(unaffected.routingStats.connectivityIndexHits,1);
  changed.networkProfiles.A.routes.push({id:'express',stNodeIds:['n0','n3'],serviceCount:8,
    stComboTimings:[{stNodeIndex:0,arrivalTime:0,departureTime:0},{stNodeIndex:1,arrivalTime:60,departureTime:120}]});
  changed.networkProfiles.A.activeRouteIds.push('express');
  const improved=calculateCrossTileModeShares({...changed,routingCache});
  assert.deepEqual(outcomes(improved),outcomes(exact(changed)));
  assert.ok(improved.routingStats.searches>0);
});

test('directed corridor contraction preserves departures, intermediate destinations and shared source expansion',()=>{
  const input=fixture(), p=input.networkProfiles.A;
  p.routes[0].stComboTimings=[0,1,2,3].map(i=>({stNodeIndex:i,arrivalTime:i*100,departureTime:i*100+20}));
  const result=calculateCrossTileModeShares(input);
  assert.deepEqual(outcomes(result),outcomes(exact(input)));
  assert.ok(result.routingStats.corridorEdges>0);
  input.crossDemand.pops=[['backwards',100,2,0,0]];
  const reversed=calculateCrossTileModeShares(input);
  assert.equal(reversed.routingStats.connectivityRejects,1);
  assert.equal(reversed.routingStats.searches,0);
});

test('cache eviction and explicit clearing preserve outcomes',()=>{
  const input=fixture(), routingCache=createCrossTileRoutingCache({maxSearchLabels:1,maxPaths:1,maxCatchments:1});
  for(let i=0;i<3;i++) {
    const result=calculateCrossTileModeShares({...input,routingCache});
    assert.deepEqual(outcomes(result),outcomes(exact(input)));
    assert.ok(result.routingStats.retainedSearchLabels<=1);
  }
  routingCache.clear();
  assert.equal(calculateCrossTileModeShares({...input,routingCache}).routingStats.graphBuilds,1);
});

test('new service connects a formerly impossible station pair',()=>{
  const input=fixture(),routingCache=createCrossTileRoutingCache();
  const unserved=structuredClone(input);
  unserved.networkProfiles.A.routes=[];unserved.networkProfiles.A.activeRouteIds=[];
  assert.equal(calculateCrossTileModeShares({...unserved,routingCache}).transitViablePops,0);
  assert.deepEqual(outcomes(calculateCrossTileModeShares({...input,routingCache})),outcomes(exact(input)));
});

test('equal-cost route ordering preserves uncached fare attribution after a profile update',()=>{
  const input=fixture(),routingCache=createCrossTileRoutingCache();
  const alternate={...structuredClone(input.networkProfiles.A.routes[0]),id:'alternate'};
  input.networkProfiles.A.routes.push(alternate);
  input.networkProfiles.A.activeRouteIds.push(alternate.id);
  calculateCrossTileModeShares({...input,routingCache});
  input.networkProfiles.A.routes.reverse();
  assert.deepEqual(outcomes(calculateCrossTileModeShares({...input,routingCache})),outcomes(exact(input)));
});

test('seeded branching networks agree with uncached routing across departures and access distances',()=>{
  let seed=17; const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
  for(let trial=0;trial<25;trial++) {
    const input=fixture(),p=input.networkProfiles.A;
    for(let r=0;r<3;r++) {
      const nodes=[0,1,2,3].filter(()=>random()>0.25);
      if(nodes.length<2) continue;
      const route={id:`r${r}`,stNodeIds:nodes.map(i=>`n${i}`),serviceCount:1+Math.floor(random()*4),
        stComboTimings:nodes.map((_,i)=>({stNodeIndex:i,arrivalTime:i*180,departureTime:i*180+30}))};
      p.routes.push(route);p.activeRouteIds.push(route.id);
    }
    input.crossDemand.popFields=['id','mass','home','work','gateway','homeDepartureTime'];
    input.crossDemand.points[0][1]=random()*0.005;
    input.crossDemand.pops=Array.from({length:12},(_,i)=>[`p${i}`,100,0,1+i%2,0,Math.floor(i/4)*200]);
    assert.deepEqual(outcomes(calculateCrossTileModeShares(input)),outcomes(exact(input)),`trial ${trial}`);
  }
});
