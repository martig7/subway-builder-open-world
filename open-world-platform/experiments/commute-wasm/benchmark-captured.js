(async()=>{
  const rows=window.__commuteBenchmarkInputs;
  if(!rows?.length)throw new Error('No captured inputs');
  const factories=window.__commuteBenchmarkFactories,sources=window.__commuteBenchmarkSources;
  const variants=window.__commuteBenchmarkVariants??['javascript','wasm'];
  const repeats=window.__commuteBenchmarkRepeats??1;
  const selected=window.__commuteBenchmarkSelection??'all';
  const records=[];
  const replace=(key,value)=>['routingStats','contextKey','evaluationKey'].includes(key)?undefined:value instanceof Map?[...value]:value;
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value,replace))))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const inputs=rows.map(row=>({...row,bytes:row.message.bytesBase64?Uint8Array.from(atob(row.message.bytesBase64),c=>c.charCodeAt(0)):null}));
  for(let repeat=0;repeat<repeats;repeat++) for(const variant of variants){
    const native=factories.createNative({workerSource:sources[variant].native}),cross=factories.createCross({workerSource:sources[variant].cross});
    try{
      for(const row of inputs){
        if(selected==='ultra'&&!row.message.input.includeAssignments)continue;
        if(selected==='cross'&&row.message.input.includeAssignments)continue;
        const input={...row.message.input,existingProfile:null,worldId:`benchmark-${repeat}-${variant}`};
        let result; const start=performance.now();
        if(row.bytes) result=await native.evaluate(row.bytes.slice(),input,{gzip:row.message.gzip});
        else{
          const quotes=new Map(row.quotes??[]);
          input.journeyFare=stationRoutes=>{
            const quote=quotes.get(JSON.stringify(stationRoutes));
            if(!quote)throw new Error('Route attribution differs from captured native fare request');
            return quote;
          };
          result=await cross.evaluate(input);
        }
        const milliseconds=performance.now()-start;
        const digest=await hash(result);
        const record={repeat,variant,key:row.key,milliseconds,hash:digest,baselineHash:row.hash,parity:digest===row.hash,
          evaluatedPops:result.profile?.evaluatedPops??result.evaluatedPops,routingStats:result.profile?.routingStats??result.routingStats};
        records.push(record);
        window.__commuteBenchmarkProgress={repeat,variant,key:row.key,milliseconds,parity:record.parity,completed:records.length};
        if(!record.parity) { window.__commuteBenchmarkMismatch={record,result}; throw new Error(`Outcome mismatch: ${variant} ${row.key}`); }
      }
    }finally{native.dispose();cross.dispose();}
  }
  window.__commuteBenchmarkResults=records;
  return {selection:selected,records};
})()
