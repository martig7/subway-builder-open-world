import test from 'node:test';
import * as demandState from '../src/runtime/demand-extension-state.js';
import { evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import assert from 'node:assert/strict';
import { normalizeDemandExtension, mergeDemandExtensions, sameDemandExtensionScalars, DemandExtensionStore } from '../src/runtime/demand-extension-state.js';
import { createDemandExtensionRuntime, demandContextRegistry } from '../src/runtime/demand-context.js';
const crossPayload = () => ({
 ledger: '{}', points: [], pops: [],
 endpoints: [{id:'home',location:[0,0],tileId:'A',residents:50}, {id:'job',location:[1,0],tileId:'B',jobs:50}],
 crossPops: [{id:'cross-1',residenceId:'home',jobId:'job',size:50,drivingSeconds:3600,homeDepartureTime:28800,workDepartureTime:61200}],
});
test('cross endpoints and pops survive normalization without entering native demand', () => {
 const raw=crossPayload(), normalized=normalizeDemandExtension(raw);
 assert.deepEqual(normalized,raw);
 const base={points:[{id:'home',location:[0,0],residents:100,jobs:0}],pops:[]};
 assert.deepEqual(mergeDemandExtensions(base,[normalized]),base);
 assert.equal(sameDemandExtensionScalars(normalized,{...normalized,ledger:'{"pressure":2}'}),true);
 assert.equal(sameDemandExtensionScalars(normalized,{...normalized,crossPops:[{...normalized.crossPops[0],size:51}]}),false);
});

function fixture({readGrowthCandidates=async()=>[],storage=new Map()}={}) {
 let n=0;const context={providerId:'p',definitionId:'d',resolvedWorldId:'w',tileId:'A',cityCode:'A',nativeSessionId:'s',epoch:1,demandReady:true};
 const state={financialHistory:{},setFinancialHistory(x){this.financialHistory=x},setTimeConfig(){}};
 const ownership=Object.freeze({version:1,key:'exact-owner-v1',ownerAt:c=>c[0]<.5?'A':'B',contains:(id,c)=>id===(c[0]<.5?'A':'B')});
 const dd={points:new Map([['home',{id:'home',location:[0,0],residents:0,jobs:0}]]),popsMap:new Map()};
 const api={gameState:{getDemandData:()=>dd}};
 const runtime=createDemandExtensionRuntime({api,game:{callbacks:{getState:()=>state}},storage,readContext:()=>context,
   getOwnership:()=>ownership,readGrowthCandidates,createId:()=>String(++n),onError:()=>{}});
 return{runtime,context,state,dd,ownership,storage,api};
}
test('durable cross reads preserve routing keys through pressure-only and native-only edits',async()=>{
 const f=fixture();await f.runtime.activate({worldId:'w',tileId:'A'});
 await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'one',apply:crossPayload});
 const key=f.runtime.crossKeyFor(), records=await f.runtime.crossRecords();
 assert.equal(records.length,1);assert.deepEqual(records[0].payload.crossPops,crossPayload().crossPops);
 assert.equal(records[0].tileId,'A');assert.equal(records[0].extensionId,'induced');
 await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'pressure',apply:()=>({...crossPayload(),ledger:'{"pressure":3}'})});
 assert.equal(f.runtime.crossKeyFor(),key);
 await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'native',apply:()=>({...crossPayload(),points:[{id:'local',location:[.1,0]}]})});
 assert.equal(f.runtime.crossKeyFor(),key);
 await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'size',apply:()=>({...crossPayload(),crossPops:[{...crossPayload().crossPops[0],size:51}]})});
 assert.notEqual(f.runtime.crossKeyFor(),key);
});
test('growth candidate reads and ownership handles fence same-city reloads and provider replacement',async()=>{
 let release;const wait=new Promise(r=>release=r);let received;
 const f=fixture({readGrowthCandidates:async(context,options)=>{received=options;await wait;return [{id:'job',location:[1,0],tileId:'B',jobs:200}]}});
 await f.runtime.activate({worldId:'w',tileId:'A'});
 const registry=demandContextRegistry({});registry.register('p',f.runtime);const expected=registry.getContext();
 assert.equal(registry.growthVersion,1);assert.equal(registry.ownershipVersion,1);
 const handle=registry.getOwnership(expected);assert.ok(Object.isFrozen(handle));assert.equal(handle.ownerAt([1,0]),'B');
 const pending=registry.readGrowthState('induced',expected,{stations:[[0,0]],radiusM:1000,limit:10});
 await Promise.resolve();f.context.nativeSessionId='replacement';release();
 await assert.rejects(pending,/context|superseded|changed/i);assert.equal(received.limit,10);
 assert.equal(handle.ownerAt([1,0]),'B','issued immutable geometry remains cheap and stable');
 assert.throws(()=>registry.getOwnership(expected),/context|changed/i);
 const next=registry.getContext(), nextHandle=registry.getOwnership(next);registry.register('p',f.runtime);
 assert.equal(nextHandle.contains('A',[0,0]),true);
 assert.throws(()=>registry.getOwnership(next),/provider|replaced/i);
});

test('ownership partition preserves local, cross-owner and same-foreign-owner cohorts', () => {
  const payload = {ledger:'{"pressure":7}', points:[{id:'local',location:[.1,0]},{id:'foreign',location:[1,0]}],
    pops:[{id:'local-pop',residenceId:'home',jobId:'local',size:2},
      {id:'cross-pop',residenceId:'home',jobId:'foreign',size:3},
      {id:'foreign-pop',residenceId:'foreign',jobId:'job',size:4}]};
  const pointById = id => ({home:{id:'home',location:[0,0]},job:{id:'job',location:[2,0]}}[id]);
  const partition = demandState.partitionDemandExtension(payload,{tileId:'A',ownerAt:c=>c[0]<.5?'A':'B',pointById});
  assert.deepEqual(partition.points,payload.points.slice(0,1));
  assert.deepEqual(partition.pops,payload.pops.slice(0,1));
  assert.deepEqual(partition.crossPops,payload.pops.slice(1));
  assert.deepEqual(partition.endpoints.map(p=>[p.id,p.tileId]),[['foreign','B'],['home','A'],['job','B']]);
  assert.equal(partition.ledger,payload.ledger);
  assert.throws(()=>demandState.partitionDemandExtension(payload,{tileId:'A',ownerAt:()=>null,pointById}),/owner/i);
  assert.throws(()=>demandState.partitionDemandExtension({...crossPayload(),endpoints:[{...crossPayload().endpoints[0],tileId:'B'},crossPayload().endpoints[1]]},
    {tileId:'A',ownerAt:c=>c[0]<.5?'A':'B',pointById}),/owner/i);
});

test('legacy foreign native cohorts migrate once through the editor and preserve the old checkpoint',async()=>{
  const f=fixture(), calls=[];
  f.dd.points.set('foreign',{id:'foreign',location:[1,0],residents:4,jobs:3});
  f.dd.points.set('job',{id:'job',location:[2,0],residents:0,jobs:4});
  const raw={ledger:'{"pressure":7}',points:[{id:'foreign',location:[1,0]}],
    pops:[{id:'cross-pop',residenceId:'home',jobId:'foreign',size:3},
      {id:'foreign-pop',residenceId:'foreign',jobId:'job',size:4}]};
  for(const p of raw.pops) f.dd.popsMap.set(p.id,{...p});
  f.api.demand={removePops(ids){calls.push(['pops',...ids]);for(const id of ids)f.dd.popsMap.delete(id);return{success:true}},
    removeDemandPoint(id){calls.push(['point',id]);f.dd.points.delete(id);return{success:true}},
    addDemandPoint(){throw Error('foreign point restored')},addPops(){throw Error('foreign cohort restored')}};
  let n=0;const store=new DemandExtensionStore({storage:f.storage,createId:()=> 'legacy-'+(++n)});
  const before=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',raw,'legacy');
  f.state.financialHistory.openWorldDemandCheckpoint=before.marker;
  await f.runtime.activate({worldId:'w',tileId:'A'});
  assert.deepEqual(calls,[['pops','cross-pop','foreign-pop'],['point','foreign']]);
  assert.equal(f.dd.popsMap.size,0);assert.equal(f.dd.points.has('job'),true,'packaged foreign endpoint is not extension-owned');
  const growth=await f.runtime.readGrowthState('induced',f.runtime.getContext());
  assert.deepEqual(growth.crossPops,raw.pops);assert.equal(growth.ledger,raw.ledger);
  const selected=f.state.financialHistory.openWorldDemandCheckpoint;
  assert.notEqual(selected.key,before.marker.key);
  assert.deepEqual((await store.readRecord(before.recordKey)).pops,raw.pops);
  calls.length=0;f.context.epoch++;
  await f.runtime.activate({worldId:'w',tileId:'A',nativeAuthoritativeLoad:true});
  assert.deepEqual(calls,[]);assert.equal(f.state.financialHistory.openWorldDemandCheckpoint.key,selected.key);
});

test('malformed sparse cross data fails closed, including duplicate IDs and undescribed endpoints',()=>{
  const raw=crossPayload();
  assert.throws(()=>normalizeDemandExtension({...raw,endpoints:[...raw.endpoints,raw.endpoints[0]]}),/duplicate/i);
  assert.throws(()=>normalizeDemandExtension({...raw,crossPops:[...raw.crossPops,raw.crossPops[0]]}),/duplicate/i);
  assert.throws(()=>normalizeDemandExtension({...raw,endpoints:raw.endpoints.slice(0,1)}),/undescribed/i);
  assert.throws(()=>normalizeDemandExtension({...raw,endpoints:[{...raw.endpoints[0],location:[181,0]},raw.endpoints[1]]}),/endpoint/i);
  assert.throws(()=>normalizeDemandExtension({...raw,crossPops:[{...raw.crossPops[0],drivingSeconds:Infinity}]}),/drivingSeconds/i);
});

test('growth candidates are foreign jobs only, bounded, and immutable snapshots',async()=>{
  const f=fixture({readGrowthCandidates:async()=>[
    {id:'local',location:[0,0],tileId:'A',jobs:100},
    {id:'empty',location:[1,0],tileId:'B',jobs:0},
    {id:'foreign-one',location:[1,0],tileId:'B',jobs:100},
    {id:'foreign-two',location:[2,0],tileId:'B',jobs:200}]});
  await f.runtime.activate({worldId:'w',tileId:'A'});
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'one',apply:crossPayload});
  const projection=await f.runtime.readGrowthState('induced',f.runtime.getContext(),{limit:1});
  assert.deepEqual(projection.candidates.map(p=>p.id),['foreign-one']);
  projection.crossPops[0].size=999;projection.endpoints[0].location[0]=10;
  assert.equal((await f.runtime.crossRecords())[0].payload.crossPops[0].size,50);
  const g=fixture({readGrowthCandidates:async()=>[{id:'bad',location:[0,0],tileId:'B',jobs:100}]});
  await g.runtime.activate({worldId:'w',tileId:'A'});
  await assert.rejects(g.runtime.readGrowthState('induced',g.runtime.getContext()),/ownership mismatch/i);
  assert.equal(g.runtime.getContext().demandReady,true);assert.equal(g.dd.popsMap.size,0);
});

test('captured foreign mutation retries editor failure without reapplying native growth',async()=>{
  const f=fixture();await f.runtime.activate({worldId:'w',tileId:'A'});
  let applies=0,removes=0,fail=true;
  f.dd.points.set('job',{id:'job',location:[1,0],jobs:0,residents:0});
  f.api.demand={removePops(ids){removes++;if(fail)return{success:false,error:'edit unavailable'};
    for(const id of ids)f.dd.popsMap.delete(id);return{success:true}},removeDemandPoint(){throw Error('no materialized points')}};
  const expected=f.runtime.getContext(), pop={id:'migration',residenceId:'home',jobId:'job',size:50};
  const mutation={mutationId:'one',apply(){applies++;f.dd.popsMap.set(pop.id,{...pop});return{ledger:'{}',pops:[pop],points:[]}}};
  await assert.rejects(f.runtime.runMutation('induced',expected,mutation),/edit unavailable/i);
  assert.equal(applies,1);assert.equal(f.dd.popsMap.size,1);assert.equal(f.state.financialHistory.openWorldDemandCheckpoint,undefined);
  fail=false;await f.runtime.runMutation('induced',expected,mutation);
  assert.equal(applies,1);assert.equal(removes,2);assert.equal(f.dd.popsMap.size,0);
  assert.deepEqual((await f.runtime.crossRecords())[0].payload.crossPops,[pop]);
});

test('unknown legacy endpoints fail before all native edits and preserve the saved marker',async()=>{
  const f=fixture();const calls=[];
  f.api.demand={removePops(){calls.push('remove');return{success:true}},removeDemandPoint(){calls.push('point');return{success:true}},
    addPops(){calls.push('add');return{success:true,popIds:[]}}};
  let n=0;const store=new DemandExtensionStore({storage:f.storage,createId:()=> 'unknown-'+(++n)});
  const raw={ledger:'{"pressure":7}',points:[],pops:[{id:'old',residenceId:'home',jobId:'unknown',size:3}]};
  f.dd.popsMap.set('old',{...raw.pops[0]});
  const saved=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',raw,'old');
  f.state.financialHistory.openWorldDemandCheckpoint=saved.marker;
  await assert.rejects(f.runtime.activate({worldId:'w',tileId:'A'}),/ownership/i);
  assert.deepEqual(calls,[]);assert.deepEqual(f.state.financialHistory.openWorldDemandCheckpoint,saved.marker);
  assert.equal(f.runtime.getContext().demandReady,false);assert.equal(f.dd.popsMap.size,1);
});

test('selected older checkpoints exclude later cross tiles and have distinct edited branch keys',async()=>{
  const f=fixture();let n=0;const store=new DemandExtensionStore({storage:f.storage,createId:()=> 'branch-'+(++n)});
  const first=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',crossPayload(),'a');
  const later=await store.commit(first.checkpoint,'B','induced',crossPayload(),'b');
  f.state.financialHistory.openWorldDemandCheckpoint=first.marker;
  await f.runtime.activate({worldId:'w',tileId:'A'});
  const selected=await f.runtime.crossRecords();assert.deepEqual(selected.map(r=>r.tileId),['A']);
  const key=f.runtime.crossKeyFor();assert.ok(!key.includes('branch-3'));
  const changed={...crossPayload(),crossPops:[{...crossPayload().crossPops[0],size:51}]};
  const branch=await store.commit(first.checkpoint,'A','induced',changed,'different');
  assert.notEqual(branch.checkpoint.tiles.A.crossRoutingKey,first.checkpoint.tiles.A.crossRoutingKey);
  assert.equal((await store.readCheckpoint(later.marker,'w')).tiles.B.extensions.induced,later.recordKey);
});

test('cross checkpoint reads are sequential and cancel when the selected native save changes',async()=>{
  const entries=new Map();let selectedRead=false,reads=[],active=0,maxActive=0,release;
  const wait=new Promise(done=>release=done);
  const storage={set:(key,value)=>entries.set(key,value),async get(key){
    if(selectedRead&&key.includes('demand-extension:w:B:')){reads.push(key);active++;maxActive=Math.max(maxActive,active);await wait;active--;}
    return entries.get(key);
  }};
  const f=fixture({storage});let n=0;const store=new DemandExtensionStore({storage,createId:()=> 'read-'+(++n)});
  const first=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',crossPayload(),'a');
  const b=await store.commit(first.checkpoint,'B','induced',crossPayload(),'b');
  const c=await store.commit(b.checkpoint,'C','induced',crossPayload(),'c');
  f.state.financialHistory.openWorldDemandCheckpoint=c.marker;await f.runtime.activate({worldId:'w',tileId:'A'});
  selectedRead=true;const pending=f.runtime.crossRecords();
  while(!reads.length)await Promise.resolve();
  f.context.epoch++;f.state.financialHistory.openWorldDemandCheckpoint=first.marker;
  await f.runtime.activate({worldId:'w',tileId:'A',nativeAuthoritativeLoad:true});release();
  await assert.rejects(pending,/checkpoint changed/i);assert.equal(reads.length,1);assert.equal(maxActive,1);
});

test('registration listeners can acquire the new ownership capability immediately',async()=>{
  const f=fixture();await f.runtime.activate({worldId:'w',tileId:'A'});const registry=demandContextRegistry({});
  let acquired;registry.subscribe(()=>{const context=registry.getContext();if(context) acquired=registry.getOwnership(context)});
  registry.register('p',f.runtime);assert.equal(acquired.ownerAt([1,0]),'B');
});

test('active-owned cohorts must use the native lane, while foreign same-owner virtual cohorts survive',()=>{
  const raw=crossPayload(), local={...raw,endpoints:[raw.endpoints[0],{...raw.endpoints[1],location:[.1,0],tileId:'A'}]};
  assert.throws(()=>demandState.partitionDemandExtension(local,{tileId:'A',ownerAt:c=>c[0]<.5?'A':'B'}),/native|active/i);
  const foreign={...raw,endpoints:[{...raw.endpoints[0],location:[1,0],tileId:'B'},raw.endpoints[1]]};
  assert.deepEqual(demandState.partitionDemandExtension(foreign,{tileId:'A',ownerAt:c=>c[0]<.5?'A':'B'}).crossPops,raw.crossPops);
});

test('optional pristine-package merge partitions legacy overlay without mutating its old manifest',()=>{
  const base={points:[{id:'home',location:[0,0],residents:0,jobs:0},{id:'work',location:[.1,0],residents:0,jobs:0}],pops:[]};
  const old={ledger:'{"pressure":7}',points:[{id:'foreign',location:[1,0]}],
    pops:[{id:'local',residenceId:'home',jobId:'work',size:2},{id:'virtual',residenceId:'home',jobId:'foreign',size:3}]};
  const before=structuredClone(old);
  const merged=mergeDemandExtensions(base,[old],{tileId:'A',ownerAt:c=>c[0]<.5?'A':'B'});
  assert.deepEqual(merged.pops,[old.pops[0]]);assert.equal(merged.points.some(p=>p.id==='foreign'),false);
  assert.equal(merged.points.find(p=>p.id==='home').residents,2);assert.deepEqual(old,before);assert.equal(base.points[0].residents,0);
});

test('a zero growth-candidate limit reads restored cohorts without building a foreign index',async()=>{
  let calls=0;const f=fixture({readGrowthCandidates:async()=>{calls++;return[]}});
  await f.runtime.activate({worldId:'w',tileId:'A'});
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'one',apply:crossPayload});
  const growth=await f.runtime.readGrowthState('induced',f.runtime.getContext(),{limit:0});
  assert.equal(calls,0);assert.deepEqual(growth.candidates,[]);assert.equal(growth.crossPops.length,1);
});

test('inactive legacy overlays use ownership-known points and pristine native endpoint proof before worker merge',async()=>{
  const f=fixture();let n=0;const store=new DemandExtensionStore({storage:f.storage,createId:()=> 'inactive-'+(++n)});
  const raw={ledger:'{"pressure":7}',points:[{id:'foreign',location:[0,0]}],
    pops:[{id:'local',residenceId:'base-home',jobId:'base-work',size:2},
      {id:'old-cross',residenceId:'base-home',jobId:'foreign',size:3}]};
  const saved=await store.commit(await store.readCheckpoint(null,'w'),'B','induced',raw,'old');
  f.state.financialHistory.openWorldDemandCheckpoint=saved.marker;
  await f.runtime.activate({worldId:'w',tileId:'A'});
  const overlays=await f.runtime.extensionsFor('B');
  assert.deepEqual(overlays[0].points,[]);assert.deepEqual(overlays[0].pops,[raw.pops[0]]);
  const base={points:[{id:'base-home',location:[1,0],residents:0,jobs:0},{id:'base-work',location:[1.1,0],residents:0,jobs:0}],pops:[]};
  const merged=mergeDemandExtensions(base,overlays);assert.deepEqual(merged.pops,[raw.pops[0]]);
  const input={tileId:'B',demand:base,networkProfile:{routes:[],stations:[]},farePolicy:{},demandExtensions:overlays};
  const direct=evaluateOffTileNativeDemand(input), worker=await runNativeDemandWorkerJob({
    bytes:new TextEncoder().encode(JSON.stringify(base)),input:{...input,demand:undefined}});
  assert.equal(direct.profile.evaluatedPops,1);assert.equal(worker.profile.evaluatedPops,1);
  assert.deepEqual((await store.readRecord(saved.recordKey)).pops,raw.pops,'worker read never mutates selected old record');
  assert.throws(()=>mergeDemandExtensions({...base,points:base.points.slice(0,1)},overlays),/unloaded endpoint/i);
});

test('direct native evaluator accepts the exact ownership partition seam',()=>{
  const base={points:[{id:'home',location:[0,0],residents:0,jobs:0},{id:'work',location:[.1,0],residents:0,jobs:0}],pops:[]};
  const raw={ledger:'{}',points:[{id:'foreign',location:[1,0]}],
    pops:[{id:'local',residenceId:'home',jobId:'work',size:2},{id:'cross',residenceId:'home',jobId:'foreign',size:3}]};
  const result=evaluateOffTileNativeDemand({tileId:'A',demand:base,networkProfile:{routes:[],stations:[]},farePolicy:{},
    demandExtensions:[raw],demandOwnership:{tileId:'A',ownerAt:c=>c[0]<.5?'A':'B'}});
  assert.equal(result.profile.evaluatedPops,1);
});

test('a failed migration checkpoint retries without repeating native retirement',async()=>{
  const entries=new Map();let deny=false;const storage={get:key=>entries.get(key),set(key,value){if(deny)throw Error('disk full');entries.set(key,value)}};
  const f=fixture({storage}),calls=[];
  f.dd.points.set('foreign',{id:'foreign',location:[1,0],residents:0,jobs:3});
  const raw={ledger:'{"pressure":7}',points:[{id:'foreign',location:[1,0]}],
    pops:[{id:'old',residenceId:'home',jobId:'foreign',size:3}]};
  f.dd.popsMap.set('old',{...raw.pops[0]});
  f.api.demand={removePops(ids){calls.push('pop');for(const id of ids)f.dd.popsMap.delete(id);return{success:true}},
    removeDemandPoint(id){calls.push('point');f.dd.points.delete(id);return{success:true}}};
  let n=0;const store=new DemandExtensionStore({storage,createId:()=> 'failure-'+(++n)});
  const saved=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',raw,'old');
  f.state.financialHistory.openWorldDemandCheckpoint=saved.marker;deny=true;
  await assert.rejects(f.runtime.activate({worldId:'w',tileId:'A'}),/disk full/i);
  assert.equal(f.runtime.getContext().demandReady,false);assert.deepEqual(f.state.financialHistory.openWorldDemandCheckpoint,saved.marker);
  deny=false;await f.runtime.activate({worldId:'w',tileId:'A'});
  assert.deepEqual(calls,['pop','point']);assert.equal((await f.runtime.readGrowthState('induced',f.runtime.getContext(),{limit:0})).crossPops.length,1);
});

test('mismatched live foreign records fail migration ownership proof before native edits',async()=>{
  const f=fixture(),calls=[];f.dd.points.set('foreign',{id:'foreign',location:[1,0],residents:0,jobs:50});
  const raw={ledger:'{}',points:[],pops:[{id:'old',residenceId:'home',jobId:'foreign',size:3}]};
  f.dd.popsMap.set('old',{...raw.pops[0],size:50});
  f.api.demand={removePops(ids){calls.push('pop');for(const id of ids)f.dd.popsMap.delete(id);return{success:true}},
    removeDemandPoint(id){calls.push('point');f.dd.points.delete(id);return{success:true}}};
  let n=0;const store=new DemandExtensionStore({storage:f.storage,createId:()=> 'proof-'+(++n)});
  const saved=await store.commit(await store.readCheckpoint(null,'w'),'A','induced',raw,'old');
  f.state.financialHistory.openWorldDemandCheckpoint=saved.marker;
  await assert.rejects(f.runtime.activate({worldId:'w',tileId:'A'}),/proof|unrelated/i);
  assert.deepEqual(calls,[]);assert.equal(f.dd.popsMap.get('old').size,50);assert.deepEqual(f.state.financialHistory.openWorldDemandCheckpoint,saved.marker);
});

test('unreferenced foreign pressure banks persist without invalidating cross routing geometry',async()=>{
  const f=fixture();await f.runtime.activate({worldId:'w',tileId:'A'});
  const emptyKey=f.runtime.crossKeyFor(), bank={id:'pressure-job',location:[2,0],tileId:'B',jobs:100};
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'bank',apply:()=>({
    ledger:'{"pressure":7}',points:[],pops:[],endpoints:[bank],crossPops:[]})});
  assert.equal(f.runtime.crossKeyFor(),emptyKey);
  const restored=await f.runtime.readGrowthState('induced',f.runtime.getContext(),{limit:0});
  assert.deepEqual(restored.endpoints,[bank]);assert.equal(restored.ledger,'{"pressure":7}');
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'cross',apply:()=>({...crossPayload(),endpoints:[...crossPayload().endpoints,bank]})});
  const routedKey=f.runtime.crossKeyFor();
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'bank-shape',apply:()=>({...crossPayload(),
    ledger:'{"pressure":8}',endpoints:[...crossPayload().endpoints,{...bank,location:[3,0],jobs:101}]})});
  assert.equal(f.runtime.crossKeyFor(),routedKey);
  await f.runtime.runMutation('induced',f.runtime.getContext(),{mutationId:'route-shape',apply:()=>({...crossPayload(),
    endpoints:[crossPayload().endpoints[0],{...crossPayload().endpoints[1],location:[1.1,0]},bank]})});
  assert.notEqual(f.runtime.crossKeyFor(),routedKey);
});
