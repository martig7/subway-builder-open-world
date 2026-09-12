(async()=>{
  const get=()=>window.__subwayBuilder_storeCallbacks__.getState();
  const runtime=window.__commutePerfRuntime,cachedWorker=window.__commutePerfCachedWorker;
  const cached=window.__japanActiveRuntimeV1__.cachedSimulation,cross=window.__japanRoutePathRuntimeV1__.crossModeShares;
  if(!get().timeConfig.paused)throw new Error('Pause before live benchmarks');
  const original={cached:cachedWorker.evaluate,native:runtime.tilePackages.evaluateNativeDemandBytes,cross:cross.evaluate};
  const from=get().timeConfig.elapsedSeconds,rows=[];
  const variants=window.__commuteBenchmarkLiveVariants??['javascript','wasm'];
  const repeats=window.__commuteBenchmarkLiveRepeats??1;
  const initialEnabled=cached.snapshot().enabled;
  window.__commuteBenchmarkLiveResults=rows;
  let baseline=null;
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value,(key,item)=>['routingStats','contextKey','evaluationKey'].includes(key)?undefined:item instanceof Map?[...item]:item))))].map(v=>v.toString(16).padStart(2,'0')).join('');
  try{
    for(let repeat=0;repeat<repeats;repeat++)for(const variant of variants){
      await cached.setEnabled(false);
      const sources=window.__commuteBenchmarkSources[variant],factories=window.__commuteBenchmarkFactories;
      const active=factories.createNative({workerSource:sources.native}),native=factories.createNative({workerSource:sources.native}),crossEvaluator=factories.createCross({workerSource:sources.cross});
      cachedWorker.evaluate=active.evaluate;runtime.tilePackages.evaluateNativeDemandBytes=native.evaluate;cross.evaluate=crossEvaluator.evaluate;
      try{
        window.__commuteBenchmarkLiveProgress={variant,repeat,phase:'ultra-fast'};
        const start=performance.now();await cached.setEnabled(true);const ultraMs=performance.now()-start;
        if(cached.snapshot().status!=='ready')throw new Error('Ultra-fast preparation failed');
        const assignmentsHash=await hash([...get().demandData.popsMap.values()].map(({id,commutes,homeDepartureTime,workDepartureTime})=>({id,commutes,homeDepartureTime,workDepartureTime})));
        const profiles=runtime.world.backgroundNativeFinance.tileRevenueProfiles;const invalidated=[];
        for(const [tileId,profile]of Object.entries(profiles))if(profile.evaluatedPops>0){profiles[tileId]={...profile,contextKey:'benchmark-stale',evaluationKey:'benchmark-stale'};invalidated.push(tileId);}
        window.__commuteBenchmarkLiveProgress={variant,repeat,phase:'off-tile',ultraMs};
        const begin=performance.now();const result=await runtime.recalculateCrossTileModeShare({reason:'midnight-change',day:Math.floor(from/86400)});const crossMs=performance.now()-begin;
        if(result.nativeFinanceProfile?.status!=='ready')throw new Error('Cross recalculation incomplete');
        if(get().timeConfig.elapsedSeconds!==from)throw new Error('Clock advanced');
        const profilesHash=await hash(runtime.world.backgroundNativeFinance.tileRevenueProfiles);
        const choicesHash=await hash(runtime.world.crossPopModeChoices);
        const hashes={assignmentsHash,profilesHash,choicesHash};baseline??=hashes;
        const parity=JSON.stringify(hashes)===JSON.stringify(baseline);
        const row={variant,repeat,ultraMs,crossMs,parity,...hashes,invalidated:invalidated.length,evaluated:result.nativeFinanceProfile.evaluated,cached:result.nativeFinanceProfile.cached,assignedPops:cached.snapshot().assignedPops,dailyRevenue:cached.snapshot().dailyRevenue};
        rows.push(row);window.__commuteBenchmarkLiveProgress=row;
        if(!parity)throw new Error('Live assignments or profiles changed between backends');
      }finally{active.dispose();native.dispose();crossEvaluator.dispose();}
    }
  }finally{
    cachedWorker.evaluate=original.cached;runtime.tilePackages.evaluateNativeDemandBytes=original.native;cross.evaluate=original.cross;
    if(!initialEnabled)await cached.setEnabled(false);
  }
  return {records:rows,clock:from,topology:{stations:get().stations.length,routes:get().routes.length,tracks:get().tracks.length,trains:get().trains.length}};
})()
