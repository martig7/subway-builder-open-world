import {
  buildGeneratedRoadGraph,
  routeGeneratedRoadGraph,
} from '../../../kc-two-tile/mod/src/generated-road-routing.js';

const WORKER_MARKER = 'nec-generated-road-route-worker-v1';
const graphCache = new Map();

async function decodeRoads(bundle) {
  const bytes = new Uint8Array(bundle.bytes);
  let text;
  if (bundle.gzip) {
    if (typeof DecompressionStream !== 'function') throw new Error('Gzip road routing requires DecompressionStream');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return JSON.parse(text);
}

function retainGraph(key, graph) {
  graphCache.delete(key);
  graphCache.set(key, graph);
  while (graphCache.size > 2) graphCache.delete(graphCache.keys().next().value);
}

async function handle(message) {
  const { id, key, origin, destination, roads } = message ?? {};
  let graph = graphCache.get(key);
  if (!graph && !Array.isArray(roads)) {
    self.postMessage({ id, ok: true, status: 'roads-required' });
    return;
  }
  if (!graph) {
    const collections = [];
    for (const bundle of roads) collections.push(await decodeRoads(bundle));
    graph = buildGeneratedRoadGraph(collections);
    retainGraph(key, graph);
  } else {
    retainGraph(key, graph);
  }
  const route = routeGeneratedRoadGraph(graph, origin, destination);
  self.postMessage({
    id,
    ok: true,
    status: route ? 'routed' : 'unavailable',
    route,
    graph: { nodes: graph.nodeCount, directedEdges: graph.edgeCount },
  });
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((error) => {
    self.postMessage({
      id: data?.id,
      ok: false,
      error: { message: error?.message ?? String(error), stack: error?.stack ?? null },
    });
  });
};
self.postMessage({ type: 'ready', marker: WORKER_MARKER });
