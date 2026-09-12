const targets=await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
const target=targets.find(t=>t.title==='Subway Builder'&&t.type==='page');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
try{
  for(const [expression,name,targetName] of [
    ['window.__japanDiagnostics__.revenueSnapshot','runtime','__commutePerfRuntime'],
    ['window.__japanActiveRuntimeV1__.cachedSimulation.setEnabled','worker','__commutePerfCachedWorker'],
  ]){
    const fn=await send('Runtime.evaluate',{expression,returnByValue:false});
    const properties=await send('Runtime.getProperties',{objectId:fn.result.objectId,ownProperties:true});
    const scopes=properties.internalProperties.find(p=>p.name==='[[Scopes]]');
    const list=await send('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
    let found=false;
    for(const property of list.result){
      if(!property.value?.objectId)continue;
      const scope=await send('Runtime.getProperties',{objectId:property.value.objectId,ownProperties:true});
      const variable=scope.result.find(p=>p.name===name);
      if(!variable?.value?.objectId)continue;
      await send('Runtime.callFunctionOn',{objectId:variable.value.objectId,functionDeclaration:`function(){window[${JSON.stringify(targetName)}]=this}`,returnByValue:true});
      found=true;break;
    }
    if(!found)throw new Error(`Missing inspected benchmark binding: ${name}`);
    console.log(`Bound ${targetName}`);
  }
}finally{ws.close();}
