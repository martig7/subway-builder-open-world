// Run each case in a fresh process: node --expose-gc scripts/benchmark-boundary-heap.mjs
//   <world-directory> <overlay-json> <zoom>
// A packed overlay can be emitted with the final argument "pack" instead of zoom.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packDisplayBoundaryOverlay } from '../src/mod-builder/display-boundary-artifact.js';
import { createOpenWorldCatalog } from '../src/runtime/open-world-catalog.js';
import { tileBoundaryGeoJson } from '../src/runtime/ui/geographic-context-overlay.js';

const [worldDirectory, overlayFile, mode = '8.5'] = process.argv.slice(2);
if (!worldDirectory || !overlayFile) throw new Error('Provide a world directory, overlay JSON and zoom (or pack)');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
if (mode === 'pack') {
  process.stdout.write(JSON.stringify(packDisplayBoundaryOverlay(read(overlayFile))));
} else {
  if (!global.gc) throw new Error('Run Node with --expose-gc');
  const definition = read(path.join(worldDirectory, 'world.json'));
  const catalogSource = read(path.join(worldDirectory, definition.tileViews.catalog));
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  const boundaryOverlay = read(overlayFile);
  const { tileCatalog } = createOpenWorldCatalog({ definition, catalogSource, boundaryOverlay });
  const zoom = Number(mode);
  const start = performance.now();
  const data = tileBoundaryGeoJson(tileCatalog, null, null, zoom);
  const decodeMs = performance.now() - start;
  globalThis.boundaryHeapBenchmark = { boundaryOverlay, tileCatalog, data };
  global.gc();
  console.log(JSON.stringify({ zoom, retainedHeapBytes: process.memoryUsage().heapUsed - baseline,
    decodeMs, metric: 'Isolated Node/V8 boundary heap; excludes MapLibre workers and GPU memory' }));
}
