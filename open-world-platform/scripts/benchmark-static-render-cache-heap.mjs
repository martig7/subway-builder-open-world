import assert from 'node:assert/strict';
import { installMovementDeckVisibilityGuard } from '../src/runtime/ui/geographic-context-overlay.js';

if (!globalThis.gc) throw new Error('Run with node --expose-gc');
const count = Number(process.argv[2] ?? 30_000);
const enforceBudget = process.argv.includes('--assert-budget');
class Layer {
  constructor(data) { this.id = 'road-lines-major'; this.props = { data, visible: true }; }
  clone(overrides) { const layer = new Layer(this.props.data); layer.props = { ...this.props, ...overrides }; return layer; }
}
const data = { type: 'FeatureCollection', features: Array.from({ length: count }, (_, id) => ({
  type: 'Feature', id, properties: { name: `road-${id}` },
  geometry: { type: 'LineString', coordinates: Array.from({ length: 8 }, (_, i) => [139 + id / 1e6, 35 + i / 1e5]) },
})) };
const deck = { props: { layers: [new Layer(data)] }, setProps(next) { this.props = { ...this.props, ...next }; } };
const map = { __deck: deck, getZoom: () => 14, getStyle: () => ({ layers: [] }), getBounds: () => [138, 34, 141, 36] };
const virtualization = { signature: 'memory-fixture', haloBounds: [[138, 34, 141, 36]], renderInputs: ({ features }) => ({ features }) };
globalThis.gc();
const before = process.memoryUsage();
const start = performance.now();
installMovementDeckVisibilityGuard(map, { map }, () => virtualization, () => 1);
const durationMs = performance.now() - start;
globalThis.gc();
const after = process.memoryUsage();
const retainedBytes = after.heapUsed - before.heapUsed + after.arrayBuffers - before.arrayBuffers;
console.log(JSON.stringify({ features: count, retainedBytes, retainedMiB: retainedBytes / 2 ** 20, durationMs,
  sourceUnchanged: deck.props.layers[0].props.data.features === data.features,
  snapshotRetained: Boolean(deck.__openWorldMovementDeckVisibilityGuard.spatialCache.get(data.features)?.sourceSnapshot) }));
if (enforceBudget) assert.ok(retainedBytes < 2 ** 20, `Optional static cache retained ${retainedBytes} bytes (budget 1 MiB)`);
