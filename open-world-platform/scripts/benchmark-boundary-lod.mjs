import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpenWorldCatalog } from '../src/runtime/open-world-catalog.js';
import { BOUNDARY_LOD_VERSION, tileBoundaryGeoJson } from '../src/runtime/ui/geographic-context-overlay.js';

const world = path.resolve(process.argv[2] ?? '../worlds/japan');
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const definition = await read(path.join(world, 'world.json'));
const catalogSource = await read(path.join(world, definition.tileViews.catalog));
const boundaryOverlay = await read(path.join(world, definition.tileViews.boundaryOverlay));
const { tileCatalog } = createOpenWorldCatalog({ definition, catalogSource, boundaryOverlay });
const levels = [];
for (const level of boundaryOverlay.lods) {
  const elapsed = [];
  let bytes;
  for (let iteration = 0; iteration < 5; iteration++) {
    const start = performance.now();
    const serialized = JSON.stringify(tileBoundaryGeoJson(tileCatalog, null, null, level.minZoom));
    elapsed.push(performance.now() - start);
    bytes = Buffer.byteLength(serialized);
  }
  levels.push({ zoom: level.minZoom, vertices: level.vertexCount, bytes,
    medianSerializationMs: +elapsed.sort((a, b) => a - b)[2].toFixed(3) });
}
console.log(JSON.stringify({ marker: BOUNDARY_LOD_VERSION, levels,
  lowZoomVertexReduction: 1 - levels[0].vertices / levels.at(-1).vertices,
  metric: 'CPU GeoJSON serialization only, not in-game frame time' }, null, 2));
if (levels[0].bytes >= levels.at(-1).bytes * .1) throw new Error('Low-zoom geometry budget exceeded');
