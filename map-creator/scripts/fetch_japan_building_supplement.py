"""Read small public GSI PMTiles ranges around public census coverage gaps.

Only GET/Range requests to the fixed GSI archive are sent. Census weights,
coordinates and input files are never uploaded. Downloads are resumable.
"""
import argparse
import gzip
import hashlib
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import mapbox_vector_tile
import requests
from pmtiles.reader import Reader
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cases',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--radius-degrees',type=float,default=.003)
    args = parser.parse_args()
    if not 0 < args.radius_degrees <= .05: raise ValueError('Unreasonable lookup radius')
    args.cache.mkdir(parents=True,exist_ok=True)
    locks={}; guard=threading.Lock(); memory={}; local=threading.local()
    def get_bytes(offset,length):
        key=(offset,length)
        with guard: lock=locks.setdefault(key,threading.Lock())
        with lock:
            if key in memory: return memory[key]
            path=args.cache/f'{offset}-{length}.bin'
            if path.exists():
                data=path.read_bytes()
                if len(data)!=length: raise ValueError('Incomplete cached range')
            else:
                for attempt in range(3):
                    try:
                        if not hasattr(local,'session'): local.session=requests.Session()
                        with local.session.get(URL,headers={'Range':f'bytes={offset}-{offset+length-1}'},timeout=60,stream=True) as response:
                            if response.status_code!=206: raise ValueError(f'Range response {response.status_code}')
                            data=response.raw.read(length+1)
                            if len(data)!=length: raise ValueError('Range length mismatch')
                        break
                    except (requests.RequestException,ValueError):
                        if attempt==2: raise
                        time.sleep(2**attempt)
                path.write_bytes(data)
            memory[key]=data
            return data
    reader=Reader(get_bytes)
    reader.header()
    cases=json.loads(args.cases.read_text(encoding='utf-8'))
    if isinstance(cases,dict): cases=cases['outliers']
    z=16; n=2**z; tasks={}
    def tile(x,y):
        return int((x+180)/360*n),int((1-math.asinh(math.tan(math.radians(y)))/math.pi)/2*n)
    for case in cases:
        owner=case['owner']; lon,lat=case['location']; r=args.radius_degrees
        bounds=(lon-r,lat-r,lon+r,lat+r)
        west,south=tile(bounds[0],bounds[1]); east,north=tile(bounds[2],bounds[3])
        for x in range(west,east+1):
            for y in range(north,south+1): tasks.setdefault((owner,x,y),[]).append(box(*bounds))
    print(json.dumps({'stage':'fetch','cases':len(cases),'uniqueOwnerTiles':len(tasks)}),flush=True)
    def fetch(task):
        (owner,x,y),windows=task
        raw=reader.get(z,x,y)
        if raw is None: return [],None
        inventory={'z':z,'x':x,'y':y,'sha256':hashlib.sha256(raw).hexdigest()}
        if raw[:2]==b'\x1f\x8b': raw=gzip.decompress(raw)
        layer=mapbox_vector_tile.decode(raw,default_options={'y_coord_down':True}).get('BldA')
        if not layer: return [],inventory
        extent=layer['extent']; features=[]
        def project(px,py,pz=None):
            return (x+px/extent)/n*360-180,math.degrees(math.atan(math.sinh(math.pi*(1-2*(y+py/extent)/n))))
        for feature in layer['features']:
            geometry=transform(project,shape(feature['geometry']))
            if geometry.geom_type not in ('Polygon','MultiPolygon') or not any(geometry.intersects(window) for window in windows): continue
            features.append({'type':'Feature','properties':{**feature['properties'],'prefCode':owner,
                'tile':f'{z}/{x}/{y}','sourceId':feature.get('id'),'layer':'BldA'},'geometry':mapping(geometry)})
        return features,inventory
    features=[]; tiles=[]; started=time.monotonic()
    # Four persistent connections avoid paying for TLS on every tiny range.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for i,(rows,inventory) in enumerate(pool.map(fetch,sorted(tasks.items())),1):
            features.extend(rows)
            if inventory: tiles.append(inventory)
            if i%50==0 or i==len(tasks):
                print(json.dumps({'stage':'fetch','completed':i,'total':len(tasks),'footprints':len(features),
                                  'elapsedSeconds':round(time.monotonic()-started,1)}),flush=True)
    output={'type':'FeatureCollection','source':URL,'attribution':'国土地理院最適化ベクトルタイル',
            'tiles':tiles,'features':features}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')


if __name__=='__main__': main()
