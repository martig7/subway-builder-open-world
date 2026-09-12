import { readFile, writeFile } from 'node:fs/promises';

const [expressionFile, outputFile, profileFlag] = process.argv.slice(2);
if (!expressionFile || !outputFile) throw new Error('Usage: node run-in-game.mjs expression.js result.json [profile]');
const targets = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json());
const target = targets.find(candidate => candidate.type === 'page' && candidate.title === 'Subway Builder');
if (!target) throw new Error('The open Subway Builder debugger target is unavailable');
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  };
  return { target, close: () => socket.close(), send(method, params = {}) {
    return new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  } };
}
const page = await connect(target);
const profiles = [];
const debuggers = [];
const debuggerTargets = new Set();
let watching = true, refreshing = null;
// An already-open DevTools session may pause newly created workers. Such time
// is debugger latency, not calculation time. Suppress pauses for this run only.
async function attachDebuggers() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json());
    for (const candidate of current.filter(item => item.id === target.id || (item.type === 'worker' && /^open-world-/.test(item.title)))) {
      if (!watching || debuggerTargets.has(candidate.id)) continue;
      debuggerTargets.add(candidate.id);
      try {
        const client = candidate.id === target.id ? page : await connect(candidate);
        debuggers.push(client);
        void client.send('Debugger.enable').catch(() => {});
        void client.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
        void client.send('Debugger.resume').catch(() => {});
      } catch (error) { console.log(`Debugger attachment: ${error.message}`); }
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
const watcher = setInterval(() => { void attachDebuggers().catch(error => console.error(error.message)); }, 250);
try {
  await attachDebuggers();
  if (profileFlag === 'profile') {
    for (const candidate of targets.filter(item => item.id === target.id || (item.type === 'worker' && /^open-world-/.test(item.title)))) {
      const client = candidate.id === target.id ? page : await connect(candidate);
      await client.send('Profiler.enable');
      await client.send('Profiler.setSamplingInterval', { interval: 1000 });
      await client.send('Profiler.start');
      profiles.push(client);
    }
  }
  console.log(`Running ${expressionFile} in the open game (${profiles.length} profiled targets)`);
  const evaluated = await page.send('Runtime.evaluate', { expression: await readFile(expressionFile, 'utf8'), awaitPromise: true, returnByValue: true });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
  await writeFile(outputFile, JSON.stringify(evaluated.result.value, null, 2));
  const value = evaluated.result.value;
  console.log(JSON.stringify(value?.records ? { saved: outputFile, records: value.records.length, allParity: value.records.every(row => row.parity) } : value, null, 2));
} finally {
  watching = false; clearInterval(watcher);
  for (const client of profiles) {
    try {
      const { profile } = await client.send('Profiler.stop');
      const file = `${outputFile}.${client.target.id}.cpuprofile`;
      await writeFile(file, JSON.stringify(profile));
      const byId = new Map(profile.nodes.map(node => [node.id, node]));
      const totals = new Map();
      profile.samples?.forEach((id, index) => { const node = byId.get(id); const key = `${node.callFrame.functionName || '(anonymous)'} @ ${node.callFrame.lineNumber + 1}`; totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0)); });
      console.log(JSON.stringify({ target: client.target.title, file, topSelfMs: [...totals].sort((a,b)=>b[1]-a[1]).slice(0,18).map(([name,us])=>({name,ms:us/1000})) }));
    } finally { if (client !== page) client.close(); }
  }
  page.close();
  for (const client of debuggers) if (client !== page && !profiles.includes(client)) client.close();
}
