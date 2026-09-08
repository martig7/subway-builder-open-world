import { writeFile } from 'node:fs/promises';
const prefix = process.argv[2] ?? '.analysis/frame-pauses-1';
const reverse = process.argv.includes('--reverse');
const framesOnly = process.argv.includes('--frames-only');
const target = (await fetch('http://127.0.0.1:9222/json/list').then(r => r.json()))
  .find(t => t.type === 'page' && t.url.includes('/dist/renderer/index.html'));
if (!target) throw Error('No Subway Builder renderer debugger');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j) => { ws.onopen=r; ws.onerror=j; });
let id=0, traceDone; const pending=new Map(), errors=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(Error(m.error.message)):p.r(m.result);}else if(m.method==='Tracing.tracingComplete')traceDone?.(m.params);else if(m.method==='Runtime.exceptionThrown')errors.push(m.params);};
const call=(method,params={})=>new Promise((r,j)=>{const key=++id;pending.set(key,{r,j});ws.send(JSON.stringify({id:key,method,params}));});
async function measure(reverse) {
  const map=SubwayBuilderAPI.utils.getMap(), get=()=>__subwayBuilder_storeCallbacks__.getState();
  const original={center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch(),paused:get().timeConfig.paused};
  const inspect=()=>({city:SubwayBuilderAPI.utils.getCityCode(),paused:get().timeConfig.paused,
    cached:__japanActiveRuntimeV1__.cachedSimulation.snapshot(),guard:map.__deck.__openWorldMovementDeckVisibilityGuard.version,
    visibility:document.visibilityState,focused:document.hasFocus(),stations:get().stations.length,routes:get().routes.length});
  const before=inspect(), frames=[],tasks=[],tiles=[],phases=[],actions=[],visibility=[];
  let active=true,last=null,phase=null;
  const raf=t=>{const now=performance.now();if(last!==null)frames.push({start:last,end:now,ms:now-last,phase,raf:t});last=now;if(active)requestAnimationFrame(raf);};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())tasks.push({start:e.startTime,ms:e.duration});});
  const source=e=>{if(e.tile)tiles.push({at:performance.now(),source:e.sourceId,type:e.sourceDataType});};
  const changed=()=>visibility.push({at:performance.now(),state:document.visibilityState});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  observer.observe({entryTypes:['longtask']});map.on('sourcedata',source);document.addEventListener('visibilitychange',changed);requestAnimationFrame(raf);
  console.timeStamp('FRAME_PAUSE_SYNC:'+performance.now());
  try {
    for(const paused of (reverse?[false,true]:[true,false])) {
      get().setTimeConfig({paused});map.jumpTo({...original,zoom:10.5});await wait(1200);
      for(const kind of ['pan','zoom','combined']) {
        map.jumpTo({center:original.center,zoom:kind==='pan'?11.5:9,bearing:0,pitch:0});await wait(700);
        phase=(paused?'paused':'running')+'-'+kind;
        const run={name:phase,paused,kind,start:performance.now(),before:inspect()};
        console.timeStamp('FRAME_PHASE:'+phase);
        const directions=[[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[0,-1],[-1,0],[1,1]];
        for(let i=0;i<directions.length;i++) {
          const [dx,dy]=directions[i];
          const center=kind==='zoom'?original.center:[original.center[0]+dx*.28,original.center[1]+dy*.19];
          const zoom=kind==='pan'?11.5:[13,9,12.5,8.5,13,9.5,12,9][i];
          actions.push({at:performance.now(),phase,center,zoom});
          map.easeTo({center,zoom,duration:300,essential:true});await wait(550);
        }
        await wait(250);run.end=performance.now();run.after=inspect();phases.push(run);phase=null;
      }
    }
    return {original,before,after:inspect(),frames,tasks,tiles,phases,actions,visibility};
  } finally {
    active=false;observer.disconnect();map.off('sourcedata',source);document.removeEventListener('visibilitychange',changed);
    map.stop();map.jumpTo(original);get().setTimeConfig({paused:original.paused});
  }
}
let profiling=false,tracing=false;
try {
  await call('Runtime.enable');await call('Page.bringToFront');await call('Performance.enable');
  if(!framesOnly){await call('Profiler.enable');await call('Profiler.setSamplingInterval',{interval:1000});
  await call('Tracing.start',{categories:'toplevel,v8,devtools.timeline,blink.user_timing',transferMode:'ReturnAsStream'});tracing=true;
  await call('Profiler.start');profiling=true;}
  const result=await call('Runtime.evaluate',{expression:`(${measure.toString()})(${reverse})`,awaitPromise:true,returnByValue:true});
  if(!framesOnly){const {profile}=await call('Profiler.stop');profiling=false;
  const done=new Promise(r=>traceDone=r);await call('Tracing.end');const {stream}=await done;tracing=false;
  let chunks='';for(;;){const part=await call('IO.read',{handle:stream,size:1048576});chunks+=part.data;if(part.eof)break;}await call('IO.close',{handle:stream});
  await writeFile(prefix+'-trace.json',chunks);await writeFile(prefix+'-profile.json',JSON.stringify(profile));}
  await writeFile(prefix+'.json',JSON.stringify({result,errors},null,2));
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  const v=result.result.value;
  console.log(JSON.stringify({prefix,visibility:v.visibility,phases:v.phases.map(p=>{const xs=v.frames.filter(f=>f.start>=p.start&&f.end<=p.end).map(f=>f.ms).sort((a,b)=>a-b);return {name:p.name,seconds:(p.end-p.start)/1000,frames:xs.length,p95:xs[Math.floor(xs.length*.95)],p99:xs[Math.floor(xs.length*.99)],max:xs.at(-1),over50:xs.filter(x=>x>50).length,over100:xs.filter(x=>x>100).length,over250:xs.filter(x=>x>250).length,over500:xs.filter(x=>x>500).length};}),errors:errors.length},null,2));
} finally {if(profiling)await call('Profiler.stop').catch(()=>{});if(tracing)await call('Tracing.end').catch(()=>{});await call('Profiler.disable').catch(()=>{});ws.close();}
