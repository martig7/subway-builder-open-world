import {readFile} from 'node:fs/promises';
const inputFile=process.argv[2];
if(!inputFile)throw new Error('Usage: node load-captured-inputs.mjs captured-inputs.json');
const rows=JSON.parse(await readFile(inputFile,'utf8'));
const targets=await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
const target=targets.find(t=>t.title==='Subway Builder' && t.type==='page');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
const evaluate=expression=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
try{
  await evaluate('window.__commuteBenchmarkInputs=[]');
  for(const row of rows){
    const result=await evaluate(`window.__commuteBenchmarkInputs.push(${JSON.stringify(row)})`);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
    console.log(`Loaded ${row.key}`);
  }
}finally{ws.close();}
