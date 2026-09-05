// Real MapLibre pixel comparison; no external tiles or game process required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const [maplibrePath, playwrightPath] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath));
const bundle = await build({ entryPoints: ['open-world-platform/src/runtime/ui/geographic-context-overlay.js'], bundle: true, write: false, format: 'iife', globalName: 'overlay' });
const lib = await readFile(maplibrePath);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(req.url === '/lib.js' ? lib : req.url === '/overlay.js' ? bundle.outputFiles[0].text : '<div id="map" style="width:800px;height:600px"></div><script src="/lib.js"></script><script src="/overlay.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const rectangle = (w,s,e,n) => ({ type:'Feature', properties:{}, geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}});
    const map = new maplibregl.Map({ container:'map', center:[0,0], zoom:2, preserveDrawingBuffer:true, style:{version:8,sources:{native:{type:'geojson',data:rectangle(0,-30,40,30)}},layers:[
      {id:'background',type:'background',paint:{'background-color':'#1c3046'}},
      {id:'water',type:'fill-extrusion',source:'native',paint:{'fill-extrusion-color':'#04112c','fill-extrusion-height':0}},
    ]}});
    await new Promise(resolve => map.once('load',resolve));
    const controller = new overlay.GeographicContextOverlayController({runtime:{getActiveTileId:()=> 'A'}, tileCatalog:{tiles:[{id:'A',bounds:[0,-30,40,30],nativeMapBounds:[0,-30,40,30]}]}});
    controller.attachMap(map);
    const settle = () => new Promise(resolve => { map.once('idle',resolve); map.triggerRepaint(); });
    await settle();
    const pixel = point => {
      const p=map.project(point), gl=map.painter.context.gl, bytes=new Uint8Array(4);
      gl.readPixels(Math.round(p.x),gl.drawingBufferHeight-Math.round(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      return [...bytes];
    };
    const low={ocean:pixel([-20,0]),native:pixel([20,0])};
    map.jumpTo({center:[-20,0],zoom:12}); await settle();
    const high=pixel([-20,0]);
    map.jumpTo({center:[20,0],zoom:12}); await settle();
    const nativeHigh=pixel([20,0]);
    map.setLayoutProperty('water','visibility','none'); await settle();
    const backing=pixel([20,0]);
    map.setLayoutProperty('water','visibility','visible');
    map.jumpTo({center:[0,0],zoom:2});
    map.setLight({color:'#aaccee',intensity:.8,position:[1.2,160,55]}, {duration:0});
    controller.refresh(); await settle();
    const custom={ocean:pixel([-20,0]),native:pixel([20,0])};
    controller.dispose(); map.remove();
    return {low,high,nativeHigh,backing,custom};
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.low.ocean,result.low.native,'World and native water must render the same pixels');
  assert.deepEqual(result.high,result.low.ocean,'Ocean must remain visible when panning at high zoom');
  assert.deepEqual(result.nativeHigh,result.low.native,'Native water must remain on top at high zoom');
  assert.deepEqual(result.backing,[28,48,70,255],'Native footprint must shield land from world ocean');
  assert.ok(result.custom.ocean.every((c,i)=>Math.abs(c-result.custom.native[i])<=1),'Custom lighting must match to pixel rounding tolerance');
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
