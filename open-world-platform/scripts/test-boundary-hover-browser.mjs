// Run against the game's MapLibre distribution, not a permissive map mock.
// node scripts/test-boundary-hover-browser.mjs <maplibre-gl.js> <playwright/index.mjs>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const [maplibrePath, playwrightPath] = process.argv.slice(2);
if (!maplibrePath || !playwrightPath) throw Error('Provide MapLibre and Playwright module paths');
const { chromium } = await import(pathToFileURL(playwrightPath));
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/runtime/ui/geographic-context-overlay.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'overlay', platform: 'browser' });
const maplibre = await readFile(maplibrePath);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(req.url === '/maplibre.js' ? maplibre : req.url === '/overlay.js' ? bundle.outputFiles[0].text
    : '<html><body style="margin:0"><div id="map" style="width:800px;height:600px"></div><script src="/maplibre.js"></script><script src="/overlay.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.HOVER_BROWSER_CHANNEL || 'msedge',
    args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', e => console.error('Browser error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.errors = [];
    window.map = new maplibregl.Map({ container: 'map', center: [0, 0], zoom: 5,
      preserveDrawingBuffer: true, style: { version: 8, sources: {}, layers: [] } });
    map.on('error', e => errors.push(e.error.message));
    await new Promise(resolve => map.once('load', resolve));
    const polygon = (x) => ({ type: 'Polygon', coordinates: [[[x, -1], [x+1, -1], [x+1, 1], [x, 1], [x, -1]]] });
    window.controller = new overlay.GeographicContextOverlayController({
      tileCatalog: { tiles: [{ id: 'JP_PREF_13', boundaryGeometry: polygon(-2) },
        { id: 'JP_PREF_14', boundaryGeometry: polygon(0), boundaryLods: [
          { minZoom: 0, geometry: polygon(0) }, { minZoom: 6, geometry: polygon(0) },
        ] }] },
      runtime: { getActiveTileId: () => 'JP_PREF_13' }, onTileSelect() {},
    });
    controller.map = map;
    controller.refresh();
    await new Promise(resolve => map.once('idle', resolve));
    window.submissions = 0;
    const source = map.getSource('open-world-tile-boundaries-source');
    const setData = source.setData.bind(source);
    source.setData = (...args) => { submissions++; return setData(...args); };
    window.pixel = () => {
      const p = map.project([.5, 0]);
      const gl = map.getCanvas().getContext('webgl2') || map.getCanvas().getContext('webgl');
      const rgba = new Uint8Array(4);
      gl.readPixels(Math.round(p.x), map.getCanvas().height - Math.round(p.y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return Array.from(rgba);
    };
  });
  const before = await page.evaluate(() => pixel());
  const target = await page.evaluate(() => { const p = map.project([.5, 0]); return {x:p.x, y:p.y}; });
  await page.mouse.move(target.x, target.y);
  await page.evaluate(() => new Promise(resolve => { map.triggerRepaint(); map.once('idle', resolve); }));
  const result = await page.evaluate(() => ({ hovered: controller.hoveredTileId,
    features: map.queryRenderedFeatures(map.project([.5, 0]), {layers: ['open-world-tile-selection']})
      .map(f => ({id:f.id, tileId:f.properties.tileId, state:f.state})),
    pixel: pixel(), errors, version: maplibregl.version }));
  console.log(JSON.stringify({ before, ...result }, null, 2));
  assert.equal(result.hovered, 'JP_PREF_14', 'Pointer must reach the tile controller');
  assert.ok(result.pixel[0] > before[0] + 30, 'Hovered polygon must visibly highlight, not only update the cursor');
  // The minimal style intentionally has no native vector land layers.
  assert.deepEqual(result.errors.filter(e => !/^The layer 'open-world-land(-high-zoom)?' does not exist/.test(e)), []);
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(799, 10);
    await page.evaluate(() => new Promise(resolve => { map.triggerRepaint(); map.once('idle', resolve); }));
    assert.deepEqual(await page.evaluate(() => pixel()), before, 'Leaving the polygon clears its highlight');
    await page.mouse.move(target.x, target.y);
    await page.evaluate(() => new Promise(resolve => { map.triggerRepaint(); map.once('idle', resolve); }));
    assert.ok((await page.evaluate(() => pixel()))[0] > before[0] + 30);
  }
  assert.equal(await page.evaluate(() => submissions), 0, 'Hover must never resend polygon geometry');
  await page.evaluate(async () => {
    map.jumpTo({ zoom: 6.5 });
    controller.handleZoom();
    await new Promise(resolve => map.once('idle', resolve));
  });
  assert.equal(await page.evaluate(() => submissions), 1, 'Crossing an LOD boundary submits geometry once');
  assert.ok((await page.evaluate(() => pixel()))[0] > before[0] + 30, 'Hover state survives asynchronous LOD tiling');
  await page.evaluate(async () => {
    map.jumpTo({ zoom: 6.6 });
    controller.handleZoom();
    await new Promise(resolve => { map.triggerRepaint(); map.once('idle', resolve); });
  });
  assert.equal(await page.evaluate(() => submissions), 1, 'Fractional zoom within a level reuses geometry');
  console.log('PASS: visible hover/leave cycles, retained hover across LOD loads, no geometry resubmission on hover');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
