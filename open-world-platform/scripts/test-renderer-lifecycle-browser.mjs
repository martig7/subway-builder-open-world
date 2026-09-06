// Run with MapLibre and index extracted from the installed game's app.asar.
// node scripts/test-renderer-lifecycle-browser.mjs <maplibre.js> <index.js> <playwright/index.mjs>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const [maplibrePath, indexPath, playwrightPath] = process.argv.slice(2);
if (!maplibrePath || !indexPath || !playwrightPath) {
  throw Error('Provide extracted game MapLibre, game index, and Playwright module paths');
}
const { chromium } = await import(pathToFileURL(playwrightPath));
const [maplibre, gameIndex, bundle] = await Promise.all([
  readFile(maplibrePath, 'utf8'),
  readFile(indexPath, 'utf8'),
  build({
    entryPoints: [fileURLToPath(new URL('../src/runtime/ui/geographic-context-overlay.js', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'overlay', platform: 'browser',
  }),
]);
// Only replace the module-loader dependency. The MapLibre implementation and
// CJS interop helper are both the actual shipped code; the game app never runs.
const helper = gameIndex.match(/function getDefaultExportFromCjs\([^)]*\)\s*\{[^}]*\}/)?.[0];
assert.ok(helper, 'The extracted game must contain its CJS interop helper');
assert.match(maplibre, /^import \{ \w+ as getDefaultExportFromCjs \} from "\.\/index-[^"]+";/);
const isolatedMaplibre = maplibre.replace(/^import [^\n]+\n/, `${helper}\n`);
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
  response.end(request.url === '/maplibre.js' ? isolatedMaplibre
    : request.url === '/overlay.js' ? bundle.outputFiles[0].text
      : '<html><body><div id="map" style="width:800px;height:600px"></div><script src="/overlay.js"></script><script type="module">import { a } from "/maplibre.js"; window.maplibregl = a;</script></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true, channel: process.env.RENDERER_BROWSER_CHANNEL || 'msedge',
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.maplibregl);
  const result = await page.evaluate(async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const map = new maplibregl.Map({
      container: 'map', center: [0.5, 0.5], zoom: 11,
      style: { version: 8, sources: {
        water: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      }, layers: [
        { id: 'background', type: 'background' },
        { id: 'water', type: 'fill', source: 'water' },
      ] },
    });
    const errors = [];
    map.on('error', (event) => errors.push(event.error?.message ?? String(event.error)));
    await new Promise((resolve) => map.once('load', resolve));
    const controller = new overlay.GeographicContextOverlayController({
      runtime: { getActiveTileId: () => 'A' },
      tileCatalog: { tiles: [{ id: 'A', bounds: [0, 0, 1, 1] }] },
    });
    controller.attachMap(map);
    await frames();
    const nativeGetStyle = map.getStyle;
    const nativeFrame = window.requestAnimationFrame;
    let styleReads = 0;
    let queuedFrames = 0;
    map.getStyle = function (...args) { styleReads++; return nativeGetStyle.apply(this, args); };
    window.requestAnimationFrame = (callback) => { queuedFrames++; return nativeFrame(callback); };
    for (let event = 0; event < 50; event++) map.fire('styledata');
    const burstQueuedFrames = queuedFrames;
    window.requestAnimationFrame = nativeFrame;
    await frames();
    const burstStyleReads = styleReads;
    map.getStyle = nativeGetStyle;

    const markers = Array.from({ length: 100 }, (_, index) => {
      const element = document.createElement('div');
      element.style.cssText = 'width:10px;height:10px;background:red';
      return new maplibregl.Marker({ element })
        .setLngLat(index % 2 ? [0.5, 0.5] : [2, 2]).addTo(map);
    });
    await frames();
    const beforeRemoval = controller.stationMarkerVisibility.apply();
    for (const marker of markers) marker.remove();
    await frames();
    // An empty partial pass must not need a full DOM sweep to release removed nodes.
    const afterRemoval = controller.stationMarkerVisibility.apply([]);
    const retainedMarkerListeners = ['move', 'moveend'].reduce((count, type) => count
      + (map._listeners?.[type] ?? []).filter((listener) => markers.some((marker) => marker._update === listener)).length, 0);
    const transientMarker = new maplibregl.Marker().setLngLat([0.5, 0.5]).addTo(map);
    transientMarker.remove();
    await frames();
    const afterTransientRemoval = controller.stationMarkerVisibility.apply([]);
    controller.dispose();
    map.remove();
    return { maplibreVersion: maplibregl.version, burstQueuedFrames, burstStyleReads,
      beforeRemoval, afterRemoval, afterTransientRemoval, retainedMarkerListeners, errors };
  });
  assert.equal(result.burstQueuedFrames, 1, '50 native styledata events must enqueue one callback');
  assert.equal(result.burstStyleReads, 1, 'The callback must share one style-layer snapshot');
  assert.equal(result.beforeRemoval, 100);
  assert.equal(result.afterRemoval, 0);
  assert.equal(result.afterTransientRemoval, 0);
  assert.equal(result.retainedMarkerListeners, 0);
  // This isolated style has no native vector basemap, so its world-land
  // layers are intentionally unavailable (as in the boundary browser test).
  assert.deepEqual(result.errors.filter((message) => !/^The layer 'open-world-land(?:-high-zoom)?' does not exist in the map's style and cannot be moved\.$/.test(message)), []);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify(result, null, 2));
  console.log('PASS: extracted-game MapLibre style batching and marker cleanup');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
