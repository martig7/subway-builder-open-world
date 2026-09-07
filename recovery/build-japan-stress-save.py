"""Create a separate METR v0 container from a v4 native save and installed demand.

No game files or source saves are modified. Topology is cloned from the known
eight-station playtest; spatial warping preserves station-scale geometry.
"""
import argparse
import base64
import bisect
import collections
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import time
import uuid
import zlib


def decode(path):
    blob = Path(path).read_bytes()
    assert blob[:4] == b'METR'
    header, aux, preview, offset, size = [struct.unpack_from('<I', blob, i)[0] for i in (8, 12, 20, 24, 28)]
    assert offset == header + aux + preview and offset + size == len(blob)
    return blob, json.loads(gzip.decompress(blob[offset:]))


def distance(a, b):
    lat1,lat2=math.radians(a[1]),math.radians(b[1])
    dlat,dlon=lat2-lat1,math.radians(b[0]-a[0])
    h=math.sin(dlat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2*6371008.8*math.asin(math.sqrt(min(1,h)))


def encode(template, save):
    header = bytearray(template[:4096])
    def field(start, size, value):
        data = value.encode('utf8')
        assert len(data) < size
        header[start:start+size] = data + bytes(size-len(data))
    field(40, 256, save['name'])
    field(296, 32, save['cityCode'])
    field(328, 64, save['gameSessionId'])
    field(392, 2048, json.dumps(save['metadata'], separators=(',', ':')))
    struct.pack_into('<Q', header, 32, save['timestamp'])
    # A fresh preview of the generated rails, encoded as a dependency-free PNG.
    tracks = save['data']['tracks']
    pts = [p for t in tracks for p in t['coords']]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    xmin,xmax,ymin,ymax=min(xs),max(xs),min(ys),max(ys)
    w, h = 480, 320
    pixels = bytearray([20, 30, 44] * w * h)
    def point(p):
        return (int(8+(p[0]-xmin)/(xmax-xmin)*(w-17)), int(h-9-(p[1]-ymin)/(ymax-ymin)*(h-17)))
    for track in tracks:
        for p, q in zip(track['coords'], track['coords'][1:]):
            x,y=point(p); xx,yy=point(q); steps=max(abs(xx-x),abs(yy-y),1)
            for k in range(steps+1):
                i=(round(y+(yy-y)*k/steps)*w+round(x+(xx-x)*k/steps))*3
                pixels[i:i+3]=bytes((255,170,70))
    def chunk(tag, data):
        return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data))
    raw=b''.join(b'\0'+pixels[y*w*3:(y+1)*w*3] for y in range(h))
    preview=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    payload=gzip.compress(json.dumps({'mainSave':save,'autosaves':[]},separators=(',',':')).encode(),mtime=0)
    for i,v in [(12,2),(16,4098),(20,len(preview)),(24,4098+len(preview)),(28,len(payload))]:
        struct.pack_into('<I',header,i,v)
    return bytes(header)+b'[]'+preview+payload


def candidates(data_root, bundle):
    text=Path(bundle).read_text(encoding='utf8')
    encoded=re.search(r'"?crossDemandGzipBase64"?\s*:\s*"([A-Za-z0-9+/=]+)"',text)[1]
    cross=json.loads(gzip.decompress(base64.b64decode(encoded)))
    allowed={'JP_TOKYO_MAINLAND','JP_KANAGAWA_MAINLAND','JP_PREF_11','JP_PREF_12'}
    groups=collections.defaultdict(int)
    for p in cross['pops']:
        a,b=cross['points'][p[2]],cross['points'][p[3]]
        if a[3] in allowed and b[3] in allowed:
            groups[(tuple(a[1:3]),tuple(b[1:3]),a[3],b[3],p[7])]+=p[1]
    native=json.loads(gzip.decompress((Path(data_root)/'JP_TOKYO_MAINLAND/demand_data.json.gz').read_bytes()))
    points={p['id']:p for p in native['points']}
    local=collections.defaultdict(int)
    for p in native['pops']:
        a,b=points[p['residenceId']]['location'],points[p['jobId']]['location']
        local[(tuple(a),tuple(b),'JP_TOKYO_MAINLAND','JP_TOKYO_MAINLAND',p['drivingSeconds'])]+=p['size']
    selected=[]
    for pool,n in [(groups,12),(local,12)]:
        count=0
        for key,mass in sorted(pool.items(),key=lambda kv:-kv[1]):
            a,b,ta,tb,seconds=key
            if distance(a,b)<4000 or seconds<600:continue
            if any(distance(a,x['home'])<600 and distance(b,x['work'])<600 for x in selected):continue
            selected.append(dict(home=a,work=b,homeTile=ta,workTile=tb,mass=mass,drivingSeconds=seconds))
            count+=1
            if count==n:break
    return selected,cross


def make_line(base, corridor, index):
    data=copy.deepcopy(base)
    data['routes']=[r for r in data['routes'] if r['stCombos']]
    assert len(data['stations'])==8 and len(data['routes'])==1
    # Remap all UUID references, including @@ lane suffixes and signal suffixes.
    raw=json.dumps(data)
    ids={s:str(uuid.uuid4()) for s in set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',raw))}
    raw=re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',lambda m:ids[m[0]],raw)
    data=json.loads(raw)
    stations=sorted(data['stations'],key=lambda s:s['coords'][0])
    src=[s['coords'] for s in stations]
    a,b=corridor['home'],corridor['work']
    dx,dy=(b[0]-a[0])*90500,(b[1]-a[1])*111195
    span=math.hypot(dx,dy); ux,uy=dx/span,dy/span
    sx=[p[0]*90500 for p in src]
    def warp(p):
        x=p[0]*90500
        i=max(0,min(6,bisect.bisect_right(sx,x)-1))
        fraction=(x-sx[i])/(sx[i+1]-sx[i])
        base_lat=src[i][1]+fraction*(src[i+1][1]-src[i][1])
        lateral=(p[1]-base_lat)*111195
        # Keep 200m around each station unscaled, stretch only interstation gaps.
        local=x-sx[i]; oldgap=sx[i+1]-sx[i]; newgap=span/7
        if local<200:along=i*newgap+local
        elif local>oldgap-200:along=(i+1)*newgap+(local-oldgap)
        else:along=i*newgap+200+(local-200)/(oldgap-400)*(newgap-400)
        return [round(a[0]+(along*ux-lateral*uy)/90500,6),round(a[1]+(along*uy+lateral*ux)/111195,6)]
    def transform(obj):
        if isinstance(obj,list):
            if len(obj)==2 and all(isinstance(v,(int,float)) for v in obj) and 139<obj[0]<141 and 35<obj[1]<37:return warp(obj)
            return [transform(v) for v in obj]
        if isinstance(obj,dict):return {k:transform(v) for k,v in obj.items()}
        return obj
    data=transform(data)
    tracks={t['id']:t for t in data['tracks']}
    for t in tracks.values():
        old=t['length'];t['length']=sum(distance(p,q) for p,q in zip(t['coords'],t['coords'][1:]))
        if t.get('curveGeometry'):
            t['curveGeometry']['length']=t['length']
            for k in ('startCurvature','endCurvature'):
                if k in t['curveGeometry']:t['curveGeometry'][k]*=old/max(t['length'],1)
    def refresh_paths(obj):
        if isinstance(obj,list):
            for v in obj:refresh_paths(v)
        elif isinstance(obj,dict):
            if 'trackId' in obj and 'length' in obj:obj['length']=tracks[obj['trackId']]['length']
            for v in obj.values():refresh_paths(v)
            if 'path' in obj and 'distance' in obj:obj['distance']=sum(p['length'] for p in obj['path'])
    refresh_paths(data['routes'])
    route=data['routes'][0];route['fullName']=f'Kanto {index:02d} '+('Cross-tile' if corridor['homeTile']!=corridor['workTile'] else 'Metro')
    route['bullet']=str(index);route['color']=['#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#06b6d4'][index%6]
    route['carsPerTrain']=10
    route['trainSchedule']={'highDemand':16,'mediumDemand':12,'lowDemand':8,'veryLowDemand':4}
    # Rebuild conservative travel-time cache from path distance; game must validate it.
    oldtimes=route['stComboTimings'];timings=[];elapsed=0
    for i,node in enumerate(route['stNodes']):
        dwell=85 if i in (0,7,14) else 25
        timings.append(dict(stNodeId=node['id'],stNodeIndex=i,arrivalTime=elapsed,departureTime=elapsed+dwell))
        if i<len(route['stCombos']):elapsed+=dwell+route['stCombos'][i]['distance']/16+20
    route['stComboTimings']=timings;route['idealTrainCount']=0;route['disruption']=None
    for i,s in enumerate(sorted(data['stations'],key=lambda s:distance(a,s['coords']))):
        s['name']=f'K{index:02d}-{i+1:02d}';s['routeIds']=[route['id']];s['nearbyStations']=[]
    for signal in data['signals']:signal['status']={'occupations':[],'reservedBy':None}
    for group in data['stationGroups']:
        s=next(s for s in data['stations'] if s['id'] in group['stationIds']);group['name']=s['name'];group['center']=s['coords']
        x,y=s['coords'];group['bounds']={'minLng':x,'maxLng':x,'minLat':y,'maxLat':y}
    return data


def main():
    p=argparse.ArgumentParser();p.add_argument('--template',required=True);p.add_argument('--data-root',required=True);p.add_argument('--bundle',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    output=Path(args.output)
    if output.exists():raise FileExistsError(output)
    blob,container=decode(args.template);save=copy.deepcopy(container['mainSave']);base=save['data']
    corridors,cross=candidates(args.data_root,args.bundle)
    keys=['tracks','routes','stNodes','stations','trackGroups','signals','stationGroups']
    merged={k:[] for k in keys}
    for i,c in enumerate(corridors,1):
        line=make_line({k:base[k] for k in keys},c,i)
        for k in keys:merged[k]+=line[k]
    base.update(merged);base['trains']=[];base['compressedDemandData']={'v':2,'p':[],'d':[],'c':[]}
    base['money']=30_000_000_000;base['timeConfig']={'paused':True,'timeSpeed':'fast','elapsedSeconds':5*3600};base['elapsedSeconds']=5*3600
    base['totalLifetimeRidership']=0;base['dailyStats']={'currentDay':0,'trainSum':0,'trainPeak':0,'capacitySum':0,'waitingPeak':0,'waitingStationId':None,'sampleCount':0,'serviceSampleCount':0,'ridershipAtDayStart':0,'lastSampleAt':0,'history':[]}
    base['financialHistory']={'entries':[],'lastHourTimestamp':0,'currentHourRevenue':0,'currentHourExpenses':0,'currentHourExpenseCategories':{}}
    base['routeFinancials']={'byRoute':{},'lastHourTimestamp':0,'currentHour':{}}
    base['ownedCarsByType']['heavy-metro']=len(corridors)*160;base['ownedTrainCount']=len(corridors)*160
    base['fareGroups'][0]['routeIds']=[r['id'] for r in base['routes']];base['fareGroups'][0]['flatFare']=2;base['transitCost']=2
    save.update(id=str(uuid.uuid4()),gameSessionId=str(uuid.uuid4()),name='Japan Kanto Cross-Tile Stress 2026-09-07',timestamp=int(time.time()*1000))
    save['metadata']={'stations':len(base['stations']),'routes':len(base['routes']),'trains':0,'money':base['money'],'elapsedSeconds':base['elapsedSeconds']}
    save['viewport']={'longitude':139.75,'latitude':35.69,'zoom':10.8,'bearing':0,'pitch':0};save['routeThumbnail']=''
    # Referential integrity checks before making a new file.
    for k in keys:assert len({v['id'] for v in base[k]})==len(base[k]),k
    tids={t['id'] for t in base['tracks']};nids={n['id'] for n in base['stNodes']}
    for route in base['routes']:
        assert len(route['stNodes'])==15 and len(route['stCombos'])==14
        assert route['stNodes'][0]['id']==route['stNodes'][-1]['id']
        for combo in route['stCombos']:
            assert combo['startStNodeId'] in nids and combo['endStNodeId'] in nids
            assert all(step['trackId'] in tids for step in combo['path'])
    output.parent.mkdir(parents=True,exist_ok=True);output.write_bytes(encode(blob,save))
    _,roundtrip=decode(output);assert roundtrip['mainSave']==save
    report={'save':str(output),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'metadata':save['metadata'],'corridors':corridors,'note':'Seeded capital and rolling stock; ridership and financial histories start empty. Cached travel times are estimates requiring native validation.'}
    output.with_suffix('.report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
