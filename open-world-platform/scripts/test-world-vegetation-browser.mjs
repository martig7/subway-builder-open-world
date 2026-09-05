// Actual MapLibre/browser smoke test with the generated worldwide artifact.
// Args: <maplibre.js> <playwright-core/index.mjs> <artifact.geojson.gz> <screenshot.png>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const [maplibrePath, playwrightPath, dataPath, screenshot] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath));
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/runtime/ui/geographic-context-overlay.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'overlay', platform: 'browser' });
const maplibre = await readFile(maplibrePath);
const data = await readFile(dataPath);
const server = createServer((req, res) => {
  if (req.url === '/vegetation') { res.end(data); return; }
  res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(req.url === '/maplibre.js' ? maplibre : req.url === '/overlay.js' ? bundle.outputFiles[0].text
    : '<html><body style="margin:0"><div id="map" style="width:1200px;height:800px"></div><script src="/maplibre.js"></script><script src="/overlay.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.errors = [];
    window.style = () => ({ version: 8, sources: {
      'general-tiles': { type: 'vector', tiles: ['http://127.0.0.1:8799/JP_TOKYO_MAINLAND/{z}/{x}/{y}.mvt'], maxzoom: 15 },
    }, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#c7c6b4' } },
      { id: 'water', type: 'fill', source: 'general-tiles', 'source-layer': 'water', paint: { 'fill-color': '#245b85' } },
      { id: 'parks-large', type: 'fill-extrusion', source: 'general-tiles', 'source-layer': 'parks', paint: { 'fill-extrusion-color': '#367e45' } },
    ] });
    window.map = new maplibregl.Map({ container: 'map', center: [0, 15], zoom: 1.3, preserveDrawingBuffer: true, style: style() });
    map.on('error', e => errors.push(e.error.message));
    await new Promise(resolve => map.once('load', resolve));
    window.controller = new overlay.GeographicContextOverlayController({ tileCatalog: { tiles: [] },
      worldContextTilesUrl: 'http://127.0.0.1:8799/JP_TOKYO_MAINLAND/{z}/{x}/{y}.mvt',
      worldVegetationLoader: async () => {
        const stream = (await fetch('/vegetation')).body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).json();
      } });
    controller.attachMap(map);
    await controller.worldVegetationPromise;
  });
  await page.waitForFunction(() => map.isStyleLoaded() && map.getLayer('open-world-vegetation'), null, { timeout: 120000 });
  const samples = await page.evaluate(() => {
    const hits = (point) => map.queryRenderedFeatures(map.project(point), { layers: ['open-world-vegetation'] }).length;
    return { amazon: hits([-60, -5]), sahara: hits([15, 23]), pacific: hits([-140, 0]), errors, version: maplibregl.version };
  });
  assert.ok(samples.amazon > 0);
  assert.equal(samples.sahara, 0);
  assert.equal(samples.pacific, 0);
  await page.screenshot({ path: screenshot });
  await page.evaluate(() => map.setPaintProperty('parks-large', 'fill-extrusion-color', '#66aa77'));
  await page.waitForFunction(() => map.getPaintProperty('open-world-vegetation', 'fill-color') === '#66aa77');
  await page.evaluate(() => map.jumpTo({ center: [-60, -5], zoom: 10 }));
  await page.waitForFunction(() => map.isStyleLoaded());
  assert.equal(await page.evaluate(() => map.queryRenderedFeatures({ layers: ['open-world-vegetation'] }).length), 0);
  await page.evaluate(() => { map.setStyle(style()); map.jumpTo({ center: [0, 15], zoom: 1.3 }); });
  await page.waitForFunction(() => map.isStyleLoaded() && map.getLayer('open-world-vegetation'));
  assert.equal(await page.evaluate(() => map.getPaintProperty('open-world-vegetation', 'fill-color')), '#367e45');
  assert.deepEqual(await page.evaluate(() => errors), []);
  console.log(JSON.stringify({ status: 'PASS', ...samples, checks: ['forest/desert/ocean', 'native theme', 'zoom 10 cutoff', 'style replacement'] }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
