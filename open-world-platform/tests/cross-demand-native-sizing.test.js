import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossDemandOverlayController } from '../src/runtime/ui/cross-demand-viewer.js';
import { nativeDemandPaint, readNativeDemandPresentation } from '../src/runtime/ui/native-demand-presentation.js';

const radius = mass => Math.sqrt(mass / Math.PI) * 6.5;
function evaluate(e, zoom, properties) {
  if (!Array.isArray(e)) return e;
  const [op, ...a] = e, v = x => evaluate(x, zoom, properties);
  if (op === 'zoom') return zoom;
  if (op === 'get') return properties[a[0]];
  if (op === 'case') return v(a[v(a[0]) ? 1 : 2]);
  if (op === '*') return a.reduce((n,x) => n*v(x),1);
  if (op === '-') return v(a[0])-v(a[1]);
  if (op === '/') return v(a[0])/v(a[1]);
  if (op === 'max') return Math.max(...a.map(v));
  if (op === 'min') return Math.min(...a.map(v));
  if (op === 'sqrt') return Math.sqrt(v(a[0]));
  if (op === 'ln') return Math.log(v(a[0]));
  if (op === '+') return a.reduce((n,x)=>n+v(x),0);
  if (op === 'interpolate') {
    const [curve,input,...stops] = a, x=v(input);
    if(x<=stops[0]) return v(stops[1]);
    for(let i=0;i<stops.length-2;i+=2) if(x<=stops[i+2]) {
      const t=(curve[1]**(x-stops[i])-1)/(curve[1]**(stops[i+2]-stops[i])-1);
      return v(stops[i+1])+(v(stops[i+3])-v(stops[i+1]))*t;
    }
    return v(stops.at(-1));
  }
  throw new Error(op);
}
function setup() {
  const layers=new Map(),sources=new Map(),handlers=new Map();
  let scale=1,latitude=35,city='a';
  const ui={userActionObj:{value:'none'},demandStatsView:'homes'};
  const root={}; const current={memoizedProps:{value:ui}};
  root.__reactContainer$test={stateNode:{current}};
  const document={getElementById:()=>root};
  const native={id:'demand-points',props:{pointRadiusScale:1,updateTriggers:{data:[true,null,0,1]},data:[]}};
  const map={isStyleLoaded:()=>true,getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
    addSource(id,s){sources.set(id,{...s,setData(data){this.data=data;}});},addLayer(l){layers.set(l.id,l);},
    setPaintProperty(id,k,v){layers.get(id).paint[k]=v;},setLayoutProperty(){},getCenter:()=>({lat:latitude}),getZoom:()=>13,
    getCanvas:()=>canvas,on(type,...args){handlers.set(type,args.at(-1));},off(type){handlers.delete(type);},
    __deck:{props:{layers:[native]}},
  };
  const canvas={style:{cursor:'crosshair'},ownerDocument:document};
  const api={actions:{getDemandBubbleScale:()=>scale},gameState:{getDemandData:()=>({points:new Map([['native',{residents:500,jobs:500}]])})}};
  const controller=new CrossDemandOverlayController({api,runtime:{getActiveTileId:()=>city,view:()=>({})},tilePackages:{loadCrossDemand:async()=>({schemaVersion:1,points:[['home',139,35,city,500,0],['work',140,36,'b',0,500]],pops:[['p',500,0,1,0]]})}});
  controller.attachMap(map);
  return {controller,map,layers,sources,handlers,native,ui,canvas,current,
    change(s,lat){scale=s;latitude=lat;city='b';},
    pixels(zoom=13){const p=sources.get('kc-cross-demand-points-source').data.features[0].properties,paint=layers.get('kc-cross-demand-points').paint;
      return {fill:evaluate(paint['circle-radius'],zoom,p),stroke:evaluate(paint['circle-stroke-width'],zoom,p)};}};
}

test('cross dots follow native scale, latitude and centered outlines after tile changes',async()=>{
 const s=setup();await s.controller.open();
 for(const [scale,lat,zoomScale] of [[1,35,1],[5,42,0.5],[0.3,30,2]]){
   s.change(scale,lat);s.native.props.pointRadiusScale=zoomScale;
   await s.controller.open();s.handlers.get('render')?.();
   for (const zoom of [10, 13, 18, 22, 24]) {
     const p=s.pixels(zoom),factor=512*2**zoom/(40030000*Math.cos(lat*Math.PI/180));
     assert.ok(Math.abs(p.fill+p.stroke/2-radius(500)*scale*zoomScale*factor)<1e-8,'dot radius must equal the native radius including its centered outline');
   }
 }
});

test('native settings and zoom updates only repaint; selected native endpoints cannot contaminate calibration',async()=>{
 const s=setup();await s.controller.open();
 const source=s.sources.get('kc-cross-demand-points-source'),data=source.data;
 s.change(5,42);s.native.props.updateTriggers.data=[true,'native',0,5];
 s.native.props.data=[{properties:{id:'native',size:800,selected:false}}];
 s.handlers.get('render')();
 const p=s.pixels(),factor=512*2**13/(40030000*Math.cos(42*Math.PI/180));
 assert.ok(Math.abs(p.fill+p.stroke/2-radius(500)*5*factor)<1e-8);
 assert.equal(source.data,data);
});

test('worker, logarithmic and tiny dots match native outer radii in both projection modes',()=>{
 for(const view of ['residents','workers']) for(const logarithmic of [false,true]) for(const pointLatitude of [false,true]) {
   const settings={scale:0.01,radiusScale:1,latitude:42,pointLatitude,logarithmic};
   const paint=nativeDemandPaint(settings,view);
   for(const population of [1,500,10000,40000]) {
     const properties={population,selected:false,latitudeScale:1/Math.cos(35*Math.PI/180)};
     const homes=view==='residents';
     const base=logarithmic?(homes?4:3)+Math.min(Math.log(population)/Math.log(10000),1)*(homes?36:27):Math.sqrt(population/Math.PI)*(homes?6.5:2.5);
     const factor=512*2**13/(40030000*Math.cos((pointLatitude?35:42)*Math.PI/180));
     const outer=evaluate(paint['circle-radius'],13,properties)+evaluate(paint['circle-stroke-width'],13,properties);
     assert.ok(Math.abs(outer-(base*0.01+2)*factor)<1e-10);
   }
 }
 const s=setup();s.map.__deck.getViewports=()=>[{projectionMode:1}];
 assert.equal(readNativeDemandPresentation({},s.map,{getItem:()=>'{"DEMAND_DOT_SCALING":true}'}).logarithmic,true);
 assert.equal(readNativeDemandPresentation({},s.map).pointLatitude,true);
});

test('calibrates against the current tile native population-to-radius mapping',async()=>{
 const s=setup();s.native.props.data=[{properties:{id:'native',size:radius(500)*5,selected:false}}];
 await s.controller.open();const p=s.pixels(),factor=512*2**13/(40030000*Math.cos(35*Math.PI/180));
 assert.ok(Math.abs(p.fill+p.stroke/2-radius(500)*5*factor)<1e-8);
});

test('construction tools suppress dot clicks and preserve the construction cursor',async()=>{
 const s=setup();await s.controller.open();s.ui.userActionObj={value:'draw-parallel-tracks',ignoreClick:true};
 s.controller.handlePointClick({features:[{properties:{id:'home'}}]});
 assert.equal(s.controller.selectedPointId,null);
 s.controller.handleMouseEnter();assert.equal(s.canvas.style.cursor,'crosshair');
 s.controller.handleMouseLeave();assert.equal(s.canvas.style.cursor,'crosshair');
 // Read the current committed provider, not a retained context from an earlier render.
 s.current.memoizedProps={value:{...s.ui,userActionObj:{value:'none'}}};
 s.controller.handlePointClick({features:[{properties:{id:'home'}}]});
 assert.equal(s.controller.selectedPointId,'home');
 s.controller.dispose();assert.equal(s.handlers.has('render'),false);
});
