
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createManagerProcessing, readManagerDemandResponse } from '../src/runtime/manager-processing.js';
import { emitProcessingValue, emitProcessingAssignments, processingReplacer } from '../scripts/manager-processing-helper.mjs';
import { createOffMainThreadNativeDemandEvaluator } from '../src/runtime/embedded-tile-package-adapter.js';
import { compactManagerDemand } from '../src/runtime/active-demand-preparation.js';
import { nativeSaveJsonChunks } from '../src/runtime/prototype-tile-save-client.js';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import { createNetworkProfile, calculateCrossTileModeShares } from '../src/runtime/cross-tile-mode-choice.js';

const profile = () => createNetworkProfile({tileId:'A',trains:[{id:'t',routeId:'r'}],
 stations:[0,1].map(i=>({id:'s'+i,coords:[i*.1,0],stNodeIds:['n'+i]})),
 routes:[{id:'r',idealTrainCount:2,stNodes:[{id:'n0'},{id:'n1'}],
 stComboTimings:[{stNodeIndex:0,arrivalTime:0,departureTime:20},{stNodeIndex:1,arrivalTime:600,departureTime:620}]}]});
const demand = {points:[{id:'h',location:[0,0]},{id:'w',location:[.1,0]}],
 pops:[{id:'p',size:100,residenceId:'h',jobId:'w',drivingSeconds:3600,drivingDistance:25000,homeDepartureTime:25000,workDepartureTime:64000}]};
const input = () => ({tileId:'A',worldId:'test',includeAssignments:true,networkProfile:profile(),farePolicy:{fare:2}});
async function helper(request, bytes, quoteFares) {
 const root=await mkdtemp(path.join(os.tmpdir(),'ow-processing-'));
 let child;
 try {
  await writeFile(path.join(root,'request.json'),JSON.stringify({version:'manager-processing-v1',...request},processingReplacer));
  await writeFile(path.join(root,'input.bin'),bytes ?? new Uint8Array());
  child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('../scripts/manager-processing-helper.mjs',import.meta.url)),root,path.join(root,'cache')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let error=''; child.stderr.on('data',bytes=>{error=(error+bytes.toString()).slice(-4096)});
  const exited=once(child,'exit'), assignments=[];
  const value=await readManagerDemandResponse(new Response(Readable.toWeb(child.stdout)),{
   onAssignments:rows=>assignments.push(...rows),onReset:()=>{assignments.length=0},quoteFares,
   reply:async value=>{child.stdin.write(JSON.stringify(value,processingReplacer)+'\n')}});
  const [code]=await exited; assert.equal(code,0,error);
  return {...value,...(request.cacheMode==='assignments'?{assignments}:{})};
 } finally { if(child?.exitCode===null)child.kill(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}
test('separate demand helper preserves assignments, profile and finance',async()=>{
 const bytes=new TextEncoder().encode(JSON.stringify(demand)),request=input(),assignments=[];
 const direct=await runNativeDemandWorkerJob({bytes,input:request,cacheMode:'assignments'},{emitAssignments:rows=>assignments.push(...rows)});
 const actual=await helper({kind:'native-demand',input:request,cacheMode:'assignments'},bytes);
 assert.deepEqual(actual.assignments,assignments);
 assert.deepEqual(actual.profile,direct.profile);
 assert.equal(actual.diskCache,'written');
});
test('separate cross-demand helper asks the game for authoritative fare attribution',async()=>{
 const request={crossDemand:{schemaVersion:1,tileId:'A',points:[['h',0,0,'A'],['w',.1,0,'A']],gateways:['local'],pops:[['p',100,0,1,0]]},
  networkProfiles:{A:createNetworkProfile({tileId:'A',stations:[0,1,2].map(i=>({id:'s'+i,coords:[i*.05,0],stNodeIds:['n'+i],nearbyStations:[],buildType:'constructed'})),routes:[{id:'r',stNodes:[0,1,2].map(i=>({id:'n'+i}))}],trains:[{id:'train',routeId:'r'}]})},gatewayCatalog:{},fare:2};
 let calls=0;
 const fare=()=>{calls++;return {total:7.35,revenueByRoute:{r:7.35}}};
 const expected=calculateCrossTileModeShares({...request,journeyFare:fare}); calls=0;
 const actual=await helper({kind:'cross-mode-share',inputFile:true,quoteFares:true},new TextEncoder().encode(JSON.stringify(request,processingReplacer)),fare);
 const {routingStats:a,...actualOutput}=actual,{routingStats:b,...expectedOutput}=expected;
 assert.deepEqual(actualOutput,expectedOutput);
 assert.ok(calls>0);
});
test('large results stream in bounded pieces and revive collections',async()=>{
 const value={rows:Array.from({length:5000},(_,i)=>({i,text:'x'.repeat(50)})),map:new Map(Array.from({length:5000},(_,i)=>['s'+i,{routes:new Set(['r']),text:'x'.repeat(50)}])),set:new Set(Array.from({length:5000},(_,i)=>'r'+i+'x'.repeat(50)))};
 value.map.set('large-array',Array.from({length:8000},(_,i)=>({i,text:'x'.repeat(600)})));
 const frames=[];await emitProcessingValue(value,frame=>frames.push(frame));
 frames.push({type:'complete',version:'manager-processing-helper-v1'});
 assert.ok(frames.length>50);
 assert.ok(frames.every(frame=>JSON.stringify(frame,processingReplacer).length<132000));
 const body=frames.map(frame=>JSON.stringify(frame,processingReplacer)+'\n').join('');
 assert.deepEqual(await readManagerDemandResponse(new Response(body)),value);
 await assert.rejects(readManagerDemandResponse(new Response(body.slice(0,body.lastIndexOf('{"type":"complete"')))),/before completion/);
 await assert.rejects(readManagerDemandResponse(new Response('{"type":"open","path":[]}\n{"type":"value","path":["__proto__"],"value":{}}\n')),/Invalid/);
});
test('manager selection precedes renderer memory admission and never falls back on failure',async()=>{
 let local=0,external=0;
 const service=createOffMainThreadNativeDemandEvaluator({workerSource:'x',WorkerClass:class{constructor(){local++}},
  readMemory:()=>{throw Error('renderer must not admit this work')},
  managerProcessing:{settings:async()=>({demandEnabled:true}),evaluateNative:async()=>{external++;throw Error('helper unavailable')}}});
 await assert.rejects(service.evaluate(()=>{throw Error('giant string must not be built')},input()),/helper unavailable/);
 assert.equal(local,0);assert.equal(external,1);service.dispose();
});
test('live demand streams scalar rows without native commutes or a whole JSON string',async()=>{
 const data={points:new Map(demand.points.map(row=>[row.id,{...row,building:{large:'unused'}}])),
 popsMap:new Map(demand.pops.map(row=>[row.id,{...row,commute:{large:'unused'}}]))};
 let body='';for await(const chunk of nativeSaveJsonChunks(compactManagerDemand(data)))body+=new TextDecoder().decode(chunk);
 assert.deepEqual(JSON.parse(body),demand);
});
test('settings default off, retain explicit choice during outage and packaged demand avoids fetch',async()=>{
 let enabled=false,offline=false,sourceCalls=0;const routes=[];
 const frames='{"type":"value","path":[],"value":{"profile":{},"diskCache":"hit"}}\n{"type":"complete","version":"manager-processing-helper-v1"}\n';
 const client=createManagerProcessing({baseUrl:'http://127.0.0.1:8799',fetchFn:async(url,options)=>{
  const route=url.pathname;routes.push(route);
  if(route.endsWith('/settings')){if(offline)throw Error('offline');return Response.json({version:'manager-processing-v1',demandEnabled:enabled,savesEnabled:enabled,stationNamingEnabled:false})}
  if(route.endsWith('/begin'))return Response.json({id:'a'.repeat(32)});
  if(route.endsWith('/run'))return new Response(frames);
  return Response.json({});
 }});
 assert.equal((await client.settings()).demandEnabled,false);
 enabled=true;await client.settings({fresh:true});offline=true;
 assert.equal((await client.settings({fresh:true})).demandEnabled,true);
 await client.evaluateNative(()=>{sourceCalls++;throw Error('unused')},input(),{packagedTileId:'A'});
 assert.equal(sourceCalls,0);assert.ok(!routes.some(route=>route.includes('/chunk/')));
 client.dispose();await assert.rejects(client.settings(),/disposed/);
});


test('cross demand uploads bounded JSON pieces with collection semantics and small metadata',async()=>{
 let begin,parts=[];
 const frames='{"type":"value","path":[],"value":{"ok":true}}\n{"type":"complete","version":"manager-processing-helper-v1"}\n';
 const client=createManagerProcessing({baseUrl:'http://127.0.0.1:8799',fetchFn:async(url,options)=>{
  if(url.pathname.endsWith('/begin')){begin=JSON.parse(options.body);return Response.json({id:'b'.repeat(32)})}
  if(url.pathname.includes('/chunk/')){assert.ok(options.body.length<1024*1024);parts.push(new TextDecoder().decode(options.body));}
  if(url.pathname.endsWith('/run'))return new Response(frames);
  return Response.json({});
 }});
 const large={crossDemand:{pops:Array.from({length:12000},(_,i)=>[i,1,0,1,'x'.repeat(50)])},networkProfiles:new Map([['A',{routes:new Set(['r'])}]])};
 await client.evaluateCross(large);
 assert.equal(begin.input,undefined);assert.equal(begin.inputFile,true);assert.ok(JSON.stringify(begin).length<500);
 assert.ok(parts.length>5);
 assert.deepEqual(JSON.parse(parts.join('')),JSON.parse(JSON.stringify(large,processingReplacer)));
 client.dispose();
});

test('large native assignment batches obey response bounds without losing rows',async()=>{
 const rows=Array.from({length:128},(_,i)=>({id:i,path:'x'.repeat(35000)})),frames=[];
 await emitProcessingAssignments(rows,frame=>frames.push(frame));
 assert.ok(frames.length>1);assert.deepEqual(frames.flatMap(frame=>frame.assignments),rows);
 assert.ok(frames.every(frame=>JSON.stringify(frame).length<132000));
});
