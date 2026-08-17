const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222/json/list';

const targets = await fetch(endpoint).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
if (!target) throw new Error('No debuggable Subway Builder page target found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const expression = String.raw`(async () => {
  const openDatabase = (name, version) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const countStore = (database, storeName) => new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).count();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const databases = await indexedDB.databases();
  const summary = [];
  for (const metadata of databases) {
    const database = await openDatabase(metadata.name, metadata.version);
    const stores = [];
    for (const storeName of database.objectStoreNames) {
      stores.push({ name: storeName, count: await countStore(database, storeName) });
    }
    summary.push({ name: metadata.name, version: metadata.version, stores });
    database.close();
  }
  return summary;
})()`;

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
if (result.exceptionDetails) {
  throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
}
console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
