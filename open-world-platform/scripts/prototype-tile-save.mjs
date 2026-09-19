/** Session-local prototype control, Node 22+. Run --help for the bounded workflow. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SequentialCdpClient, selectGameTarget } from './monitor-renderer-memory.mjs';
import { findNativeAutosaveRef } from '../src/runtime/native-autosave-idle-guard.js';

const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!['--world', '--port', '--server-state', '--capture-state', '--enable', '--disable', '--save', '--help'].includes(key) || options.has(key)) throw Error('Unknown or repeated option');
  options.set(key, ['--enable', '--disable', '--save', '--help'].includes(key) ? true : process.argv[++i]);
}
if (options.has('--help')) {
  console.log('Prototype control: --world japan --port 8800 --server-state <state directory> [--enable | --disable | --save].\nWithout an action, reports status only. Launch the game with manager diagnostics and load the updated mod first.\nThe prototype server must already be running with --save-prototype-root set to the native saves folder.\n--enable exposes the in-game session toggle. --save triggers the existing autosave callback once.\nA timed-out command may still execute when a native freeze ends; query status before retrying.');
  process.exit(0);
}
const world = options.get('--world') ?? 'japan';
if (!/^[a-z0-9-]+$/.test(world)) throw Error('Invalid World name');
const definition = JSON.parse(readFileSync(new URL(`../../worlds/${world}/world.json`, import.meta.url), 'utf8'));
const stem = definition.runtime.diagnosticNamespace.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const port = Number(options.get('--port') ?? 8800);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid prototype port');
if ([...options.keys()].filter(key => ['--enable', '--disable', '--save'].includes(key)).length > 1) throw Error('Select one action');
const smallJson = filename => { if (statSync(filename).size > 16384) throw Error('Oversized control state'); return JSON.parse(readFileSync(filename, 'utf8')); };
const capturePath = options.get('--capture-state') ?? path.join(process.env.LOCALAPPDATA, 'metro-maker4/open-world-pmtiles/state/native-game-capture.json');
const capture = smallJson(capturePath);
const origin = `http://127.0.0.1:${capture.debugPort}`;
const version = await (await fetch(origin + '/json/version', { signal: AbortSignal.timeout(3000) })).json();
if (new URL(version.webSocketDebuggerUrl).pathname !== capture.debugBrowserPath) throw Error('Game debugger identity changed; relaunch through the manager');
const target = selectGameTarget(await (await fetch(origin + '/json/list', { signal: AbortSignal.timeout(3000) })).json(), origin);
if (!target) throw Error('No game renderer found');
let configuration;
if (options.has('--enable')) {
  if (!options.has('--server-state')) throw Error('--server-state is required for --enable');
  const state = smallJson(path.join(options.get('--server-state'), `server-${port}.json`));
  const serverOrigin = `http://127.0.0.1:${port}`;
  const health = await fetch(serverOrigin + '/_health', { signal: AbortSignal.timeout(3000) });
  if (!health.ok || health.headers.get('X-PMTiles-Server-Version') !== 'native-pmtiles-directory-v4'
    || health.headers.get('X-PMTiles-Server-Instance') !== state.instanceId) throw Error('Prototype service identity mismatch');
  configuration = { origin: serverOrigin, token: state.instanceId };
}
const socket = new WebSocket(target.webSocketDebuggerUrl), client = new SequentialCdpClient(socket);
const deadline = setTimeout(() => client.close(Error('Game is busy; query status before retrying this action')), 5000);
try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const selected = `globalThis[${JSON.stringify(`__${stem}Diagnostics__`)}]?.prototypeSaveWriter`;
  let action = `const diagnostics=globalThis[${JSON.stringify(`__${stem}Diagnostics__`)}];
    const state=globalThis.__subwayBuilder_storeCallbacks__?.getState?.();
    return {writer:writer.snapshot(),probe:globalThis.__owPrototypeAutosaveProbe??null,
      paused:state?.timeConfig?.paused,clock:state?.timeConfig?.elapsedSeconds,money:state?.money,session:state?.gameSessionId,
      nativeWorkers:diagnostics.nativeCommuteWorkers?.(),cachedStatus:diagnostics.cachedSimulation?.().status,
      cachedVersion:diagnostics.cachedSimulation?.().version,autosaveGuard:diagnostics.nativeAutosaveIdle?.snapshot?.()};`;
  if (configuration) action = `await writer.configure(${JSON.stringify(configuration)});writer.setEnabled(true);return writer.snapshot();`;
  if (options.has('--disable')) action = 'writer.setEnabled(false);return writer.snapshot();';
  if (options.has('--save')) action = `
    if(!writer.snapshot().enabled)throw Error('Enable the prototype first');
    if(globalThis.__owPrototypeAutosaveProbe?.status==='running')throw Error('A probe is already running');
    const GUARD='__openWorldAutosaveIdleGuard__';
    const ref=(${findNativeAutosaveRef.toString()})();if(!ref)throw Error('Native autosave callback not recognized');
    const probe=globalThis.__owPrototypeAutosaveProbe={status:'running',startedAt:Date.now(),maxHeartbeatGapMs:0};
    let previous=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();probe.maxHeartbeatGapMs=Math.max(probe.maxHeartbeatGapMs,now-previous);previous=now;},50);
    Promise.resolve().then(()=>ref.current()).then(result=>{probe.status=result?.saved===false?result.status:'complete';if(result?.error)probe.error=result.error;},error=>{probe.status='failed';probe.error=String(error.message);}).finally(()=>{clearInterval(heartbeat);probe.finishedAt=Date.now();});
    return {status:probe.status};`;
  const expression = `(async()=>{const writer=${selected};if(!writer)throw Error('Reload the updated ${world} mod first');${action}})()`;
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, silent: true, timeout: 3000 });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  console.log(JSON.stringify(result.result.value, null, 2));
} finally { clearTimeout(deadline); client.close(); }
