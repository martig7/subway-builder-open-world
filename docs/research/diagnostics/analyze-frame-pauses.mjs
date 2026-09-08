import {readFileSync,writeFileSync} from 'node:fs';
const prefix=process.argv[2];
const v=JSON.parse(readFileSync(prefix+'.json')).result.result.value;
const es=JSON.parse(readFileSync(prefix+'-trace.json')).traceEvents;
const p=JSON.parse(readFileSync(prefix+'-profile.json'));
const sync=es.find(e=>e.name==='TimeStamp'&&e.args?.data?.message?.startsWith('FRAME_PAUSE_SYNC:'));
if(!sync)throw Error('Missing monotonic clock synchronization');
const origin=sync.ts/1000-Number(sync.args.data.message.split(':')[1]);
const main=es.filter(e=>e.pid===sync.pid&&e.tid===sync.tid&&e.ph==='X');
const gc=main.filter(e=>['MinorGC','MajorGC','V8.GCIncrementalMarking'].includes(e.name));
const nodes=new Map(p.nodes.map(n=>[n.id,n])), parents=new Map();
for(const n of p.nodes)for(const c of n.children??[])parents.set(c,n.id);
const stacks=new Map();
for(const n of p.nodes){const out=[];let id=n.id;while(id){const f=nodes.get(id).callFrame;out.push({name:f.functionName||'(anonymous)',url:f.url,line:f.lineNumber+1});id=parents.get(id);}stacks.set(n.id,out);}
let t=p.startTime/1000-origin;
const samples=p.samples.map((id,i)=>{const start=t;t+=p.timeDeltas[i]/1000;return {id,start,end:t};});
const overlap=(a,b,c,d)=>Math.max(0,Math.min(b,d)-Math.max(a,c));
function cpu(start,end){const weights=new Map();for(const s of samples){const ms=overlap(start,end,s.start,s.end);if(ms)weights.set(s.id,(weights.get(s.id)??0)+ms);}return [...weights].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([id,ms])=>({ms,stack:stacks.get(id)}));}
function trace(start,end,events){return events.map(e=>({name:e.name,start:e.ts/1000-origin,ms:e.dur/1000,args:e.args})).filter(e=>overlap(start,end,e.start,e.start+e.ms)>0).map(e=>({...e,overlapMs:overlap(start,end,e.start,e.start+e.ms)}));}
function stats(xs){xs=xs.sort((a,b)=>a-b);return {frames:xs.length,p50:xs[Math.floor(xs.length*.5)],p95:xs[Math.floor(xs.length*.95)],p99:xs[Math.floor(xs.length*.99)],max:xs.at(-1),over50:xs.filter(x=>x>50).length,over100:xs.filter(x=>x>100).length,over250:xs.filter(x=>x>250).length,over500:xs.filter(x=>x>500).length};}
const runs=v.phases.map(r=>{const fs=v.frames.filter(f=>f.start>=r.start&&f.end<=r.end),g=trace(r.start,r.end,gc);return {name:r.name,start:r.start,end:r.end,seconds:(r.end-r.start)/1000,...stats(fs.map(f=>f.ms)),gc:g.reduce((o,e)=>{const a=o[e.name]??={count:0,ms:0,max:0};a.count++;a.ms+=e.overlapMs;a.max=Math.max(a.max,e.ms);return o;},{}),tiles:v.tiles.filter(e=>e.at>=r.start&&e.at<=r.end).length,focused:r.before.focused&&r.after.focused,visible:r.before.visibility==='visible'&&r.after.visibility==='visible'};});
const frames=v.frames.filter(f=>v.phases.some(r=>f.start>=r.start&&f.end<=r.end));
const worst=frames.sort((a,b)=>b.ms-a.ms).slice(0,20).map(f=>({...f,cpu:cpu(f.start,f.end),gc:trace(f.start,f.end,gc),tasks:v.tasks.filter(e=>overlap(f.start,f.end,e.start,e.start+e.ms)>0),events:trace(f.start,f.end,main.filter(e=>e.dur>=10000)).sort((a,b)=>b.overlapMs-a.overlapMs).slice(0,18),tiles:v.tiles.filter(e=>e.at>=f.start&&e.at<=f.end).reduce((o,e)=>(o[e.source]=(o[e.source]??0)+1,o),{})}));
const out={prefix,origin,pid:sync.pid,tid:sync.tid,runs,byPause:[true,false].map(paused=>({paused,...stats(frames.filter(f=>f.phase.startsWith(paused?'paused':'running')).map(f=>f.ms))})),worst,visibility:v.visibility};
writeFileSync(prefix+'-summary.json',JSON.stringify(out,null,2));
console.log(JSON.stringify({...out,worst:worst.slice(0,10).map(f=>({phase:f.phase,ms:f.ms,gc:f.gc.map(e=>({name:e.name,ms:e.overlapMs})),cpu:f.cpu.slice(0,4).map(e=>({ms:e.ms,stack:e.stack.slice(0,12).map(f=>f.name+'@'+f.url.split('/').at(-1)+':'+f.line).join(' <- ')})),events:f.events.slice(0,5).map(e=>({name:e.name,ms:e.overlapMs})),tiles:f.tiles}))},null,2));
