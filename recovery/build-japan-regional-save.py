"""Build a fictional Japan regional railway from native topology and named hubs.

Uses the METR codec in build-japan-stress-save.py. No source save is overwritten.
Local/rapid paths share rails; a branch shares the first four physical stations.
"""
import argparse
import bisect
import collections
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
import time
import uuid

CODEC = runpy.run_path(str(Path(__file__).with_name('build-japan-stress-save.py')))
distance, decode, encode = (CODEC[k] for k in ('distance', 'decode', 'encode'))
KEYS = ['tracks', 'routes', 'stNodes', 'stations', 'trackGroups', 'signals']
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
TYPES = {
    'commuter-rail': dict(scale=1.02, cars=8, speed=27, dwell=40, turn=120, elevation=0),
    'heavy-metro': dict(scale=.85, cars=10, speed=18, dwell=25, turn=60, elevation=-18),
    'light-metro': dict(scale=.36, cars=4, speed=20, dwell=25, turn=10, elevation=10),
    'light-rail': dict(scale=.5, cars=9, speed=13, dwell=25, turn=90, elevation=0),
}
COLORS = ['#e87516', '#149a56', '#247bc1', '#a445ab', '#df3842', '#129ca2', '#a28b19', '#6858b3']


def unit(v):
    length = math.hypot(*v)
    return [x / max(length, .001) for x in v]


def geometry(source, targets, scale, parent=None):
    sx = [p[0]*90500 for p in source]
    points = [[p[0]*90500, p[1]*111195] for p in targets]
    tangents = [unit([points[min(i+1,7)][j]-points[max(0,i-1)][j] for j in range(2)]) for i in range(8)]
    if parent:
        tangents[:4] = parent['tangents'][:4]

    def warp(p):
        x = p[0]*90500
        if parent and x <= sx[3]+200:
            return parent['warp'](p)
        i = max(0, min(6, bisect.bisect_right(sx, x)-1))
        fraction = (x-sx[i])/(sx[i+1]-sx[i])
        lateral = (p[1]-source[i][1]-fraction*(source[i+1][1]-source[i][1]))*111195
        nearest = min(range(8), key=lambda k: abs(x-sx[k]))
        if abs(x-sx[nearest]) <= 200 or x < sx[0] or x > sx[-1]:
            tangent = tangents[nearest]
            center = [points[nearest][j]+(x-sx[nearest])*scale*tangent[j] for j in range(2)]
        else:
            t = (x-sx[i]-200)/(sx[i+1]-sx[i]-400)
            a = [points[i][j]+200*scale*tangents[i][j] for j in range(2)]
            b = [points[i+1][j]-200*scale*tangents[i+1][j] for j in range(2)]
            reach = math.dist(a,b)*.28
            c = [a[j]+reach*tangents[i][j] for j in range(2)]
            d = [b[j]-reach*tangents[i+1][j] for j in range(2)]
            center = [(1-t)**3*a[j]+3*(1-t)**2*t*c[j]+3*(1-t)*t*t*d[j]+t**3*b[j] for j in range(2)]
            tangent = unit([3*(1-t)**2*(c[j]-a[j])+6*(1-t)*t*(d[j]-c[j])+3*t*t*(b[j]-d[j]) for j in range(2)])
        return [round((center[0]-lateral*tangent[1])/90500, 8), round((center[1]+lateral*tangent[0])/111195, 8)]
    return dict(warp=warp, tangents=tangents)


def densify(coords):
    result = []
    for a,b in zip(coords, coords[1:]):
        steps = max(1, math.ceil(distance(a,b)/20))
        result += [[a[j]+(b[j]-a[j])*k/steps for j in range(2)] for k in range(steps)]
    return result + coords[-1:]


def configure_route(route, code, name, train_type, rapid=False):
    spec = TYPES[train_type]
    name = name.removesuffix(' Local')
    route.update(fullName=name+(' Rapid' if rapid else ' Local'), bullet=code+('R' if rapid else ''),
                 trainType=train_type, carsPerTrain=spec['cars'], idealTrainCount=0, disruption=None)
    # Moderate fleet allocations leave capacity for shared-track turnbacks.
    peak = 4 if train_type == 'commuter-rail' else 8 if train_type == 'heavy-metro' else 6
    if rapid: peak = 2
    route['trainSchedule'] = dict(highDemand=peak, mediumDemand=max(2,peak-2), lowDemand=2, veryLowDemand=1)
    if code in ('T13','W10') and not rapid:
        route['trainSchedule'] = dict(highDemand=6, mediumDemand=4, lowDemand=3, veryLowDemand=2)
    timings, elapsed = [], 0
    for i,node in enumerate(route['stNodes']):
        terminal = i in (0, len(route['stNodes'])//2, len(route['stNodes'])-1)
        dwell = spec['dwell'] + (spec['turn'] if terminal else 0)
        timings.append(dict(stNodeId=node['id'], stNodeIndex=i, arrivalTime=elapsed, departureTime=elapsed+dwell))
        if i < len(route['stCombos']): elapsed += dwell+route['stCombos'][i]['distance']/spec['speed']+25
    route['stComboTimings'] = timings


def rapid_route(local):
    route = copy.deepcopy(local)
    route['id'] = str(uuid.uuid4())
    # The native template starts at station 7, reverses at 0, and returns to 7.
    selected = [0,3,5,7,9,11,14]
    nodes = [route['stNodes'][i] for i in selected]
    combos = []
    for start,end in zip(selected, selected[1:]):
        path = []
        for combo in route['stCombos'][start:end]:
            addition = combo['path']
            # Adjacent native combos both include the complete intermediate platform.
            overlap = 0
            for n in range(1, min(len(path),len(addition))+1):
                if [(s['trackId'],s['reversed']) for s in path[-n:]] == [(s['trackId'],s['reversed']) for s in addition[:n]]:
                    overlap = n
            path += copy.deepcopy(addition[overlap:])
        combos.append(dict(startStNodeId=route['stNodes'][start]['id'], endStNodeId=route['stNodes'][end]['id'], path=path, distance=sum(s['length'] for s in path)))
    route['stNodes'], route['stCombos'] = nodes, combos
    route['terminusPlatformAlternates'] = []
    return route


def build(template, plan):
    base = {k:copy.deepcopy(template[k]) for k in KEYS}
    base['routes'] = [r for r in base['routes'] if r['stCombos']]
    source_stations = sorted(base['stations'], key=lambda s:s['coords'][0])
    assert len(source_stations) == 8 and len(base['routes']) == 1
    source = [s['coords'] for s in source_stations]
    physical_common = set()
    cutoff = source[3][0]+200/90500
    common_tracks = {t['id'] for t in base['tracks'] if max(p[0] for p in t['coords']) <= cutoff}
    for k in ['tracks','stations','stNodes','trackGroups','signals']:
        for obj in base[k]:
            refs = obj.get('trackIds', [s['trackId'] for s in obj.get('signalTracks',[])])
            include = obj['id'] in common_tracks if k == 'tracks' else bool(refs) and all(t in common_tracks for t in refs)
            if include: physical_common.add(re.match(UUID,obj['id'])[0])
    merged = {k:{} for k in KEYS}
    generated, hub_slots = {}, collections.Counter()
    station_hubs = {}
    for index,entry in enumerate(plan['corridors']):
        code,name,kind,hubs,rapid,*parent_code = entry
        assert len(hubs) == len(set(hubs)) == 8
        parent = generated[parent_code[0]] if parent_code else None
        targets = []
        for i,hub in enumerate(hubs):
            if parent and i < 4:
                targets.append(parent['targets'][i]); continue
            p = plan['hubs'][hub]
            targets.append([p[0]+hub_slots[hub]*30/90500, p[1]])
            hub_slots[hub] += 1
        shape = geometry(source, targets, TYPES[kind]['scale'], parent and parent['shape'])
        raw = json.dumps(base)
        ids = {s:str(uuid.uuid4()) for s in set(re.findall(UUID,raw))}
        if parent:
            for s in physical_common: ids[s] = parent['ids'][s]
        data = json.loads(re.sub(UUID,lambda m:ids[m[0]],raw))
        for track in data['tracks']: track['coords'] = densify(track['coords'])
        for group in data['trackGroups']:
            if group.get('centerLine'): group['centerLine'] = densify(group['centerLine'])
        def transform(obj):
            if isinstance(obj,list):
                if len(obj)==2 and all(isinstance(v,(int,float)) for v in obj) and 139<obj[0]<141 and 35<obj[1]<37:
                    return shape['warp'](obj)
                return [transform(v) for v in obj]
            if isinstance(obj,dict): return {k:kind if k=='trackType' else transform(v) for k,v in obj.items()}
            return obj
        data = transform(data)
        elevation = TYPES[kind]['elevation'] - (index%3)*6 if kind=='heavy-metro' else TYPES[kind]['elevation']
        for t in data['tracks']:
            t['length'] = sum(distance(a,b) for a,b in zip(t['coords'],t['coords'][1:]))
            t['startElevation'] = t['endElevation'] = elevation
            if t.get('curveGeometry'): t['curveGeometry']['length'] = t['length']
        for original,hub in zip(source_stations,hubs):
            station = next(s for s in data['stations'] if s['id']==ids[original['id']])
            station.update(name=hub, nearbyStations=[], maxCars=TYPES[kind]['cars'])
            station_hubs[station['id']] = hub
        for signal in data['signals']: signal['status'] = {'occupations':[], 'reservedBy':None}
        for key in KEYS:
            for obj in data[key]: merged[key].setdefault(obj['id'],obj)
        # Refresh every cache using the canonical shared geometry.
        def paths(obj):
            if isinstance(obj,list):
                for v in obj: paths(v)
            elif isinstance(obj,dict):
                if 'trackId' in obj and 'length' in obj: obj['length'] = merged['tracks'][obj['trackId']]['length']
                for v in obj.values(): paths(v)
                if 'path' in obj and 'distance' in obj: obj['distance'] = sum(s['length'] for s in obj['path'])
        local = data['routes'][0]
        paths(local)
        local['color'] = COLORS[index%len(COLORS)]
        configure_route(local,code,name,kind)
        if rapid:
            express = rapid_route(local)
            configure_route(express,code,name,kind,True)
            merged['routes'][express['id']] = express
        generated[code] = dict(ids=ids, shape=shape, targets=targets)
    data = {k:list(v.values()) for k,v in merged.items()}
    groups = collections.defaultdict(list)
    node_routes = collections.defaultdict(set)
    for route in data['routes']:
        for node in route['stNodes']: node_routes[node['id']].add(route['id'])
    for station in data['stations']:
        station['routeIds'] = sorted(set().union(*(node_routes[n] for n in station['stNodeIds'])))
        groups[station_hubs[station['id']]].append(station)
    data['stationGroups'] = []
    for name,stations in groups.items():
        xs,ys = [s['coords'][0] for s in stations],[s['coords'][1] for s in stations]
        data['stationGroups'].append(dict(id=str(uuid.uuid4()),name=name,stationIds=[s['id'] for s in stations],center=[sum(xs)/len(xs),sum(ys)/len(ys)],bounds=dict(minLng=min(xs),maxLng=max(xs),minLat=min(ys),maxLat=max(ys))))
    return data


def validate(data):
    tracks = {t['id']:t for t in data['tracks']}
    nodes = {n['id']:n for n in data['stNodes']}
    users = collections.defaultdict(set)
    max_gap = 0
    for key in KEYS+['stationGroups']: assert len({x['id'] for x in data[key]}) == len(data[key]),key
    for route in data['routes']:
        assert len(route['stNodes']) == len(route['stCombos'])+1
        assert route['stNodes'][0]['id'] == route['stNodes'][-1]['id']
        for combo in route['stCombos']:
            assert combo['startStNodeId'] in nodes and combo['endStNodeId'] in nodes
            last = None
            for step in combo['path']:
                track = tracks[step['trackId']]
                assert track['trackType'] == route['trainType']
                assert abs(step['length']-track['length']) < .001
                coords = track['coords'][::-1] if step['reversed'] else track['coords']
                if last is not None: max_gap=max(max_gap,distance(last,coords[0]))
                last = coords[-1]
                users[track['id']].add(route['id'])
            assert abs(combo['distance']-sum(s['length'] for s in combo['path'])) < .001
    assert max_gap < 2, f'Route discontinuity: {max_gap}m'
    # Include platform transfers within native station groups. Every served hub
    # must belong to one passenger graph, including the branch and tram feeders.
    graph = collections.defaultdict(set)
    for route in data['routes']:
        for a,b in zip(route['stNodes'],route['stNodes'][1:]):
            graph[a['id']].add(b['id']); graph[b['id']].add(a['id'])
    stations = {s['id']:s for s in data['stations']}
    for group in data['stationGroups']:
        members = [n for sid in group['stationIds'] for n in stations[sid]['stNodeIds']]
        for node in members: graph[node].update(members)
    visited, queue = set(), [next(iter(graph))]
    while queue:
        node = queue.pop()
        if node in visited: continue
        visited.add(node); queue.extend(graph[node]-visited)
    assert len(visited) == len(graph), 'Disconnected passenger network'
    branch = next(r for r in data['routes'] if r['bullet']=='K06')
    parent = next(r for r in data['routes'] if r['bullet']=='K05')
    assert len({n['id'] for n in branch['stNodes']} & {n['id'] for n in parent['stNodes']}) == 7
    return dict(stations=len(data['stations']), hubs=len(data['stationGroups']), routes=len(data['routes']),
                interchanges=sum(len(g['stationIds'])>1 for g in data['stationGroups']),
                trainTypes=dict(collections.Counter(r['trainType'] for r in data['routes'])),
                sharedTracks=sum(len(v)>1 for v in users.values()), trackKm=sum(t['length'] for t in tracks.values())/1000,
                maxPathGapMeters=max_gap)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--template',required=True); parser.add_argument('--output',required=True)
    parser.add_argument('--plan',default=str(Path(__file__).with_name('japan-regional-plan.json')))
    args = parser.parse_args(); output = Path(args.output)
    if output.exists(): raise FileExistsError(output)
    blob,container = decode(args.template)
    save = copy.deepcopy(container['mainSave']); data = save['data']
    plan = json.loads(Path(args.plan).read_text(encoding='utf8'))
    data.update(build(data,plan)); report=validate(data)
    data.update(trains=[], compressedDemandData={'v':2,'p':[],'d':[],'c':[]}, money=75_000_000_000,
                timeConfig={'paused':True,'timeSpeed':'fast','elapsedSeconds':18000}, elapsedSeconds=18000,totalLifetimeRidership=0)
    data['dailyStats'] = dict(currentDay=0,trainSum=0,trainPeak=0,capacitySum=0,waitingPeak=0,waitingStationId=None,sampleCount=0,serviceSampleCount=0,ridershipAtDayStart=0,lastSampleAt=0,history=[])
    data['financialHistory'] = dict(entries=[],lastHourTimestamp=0,currentHourRevenue=0,currentHourExpenses=0,currentHourExpenseCategories={})
    data['routeFinancials'] = dict(byRoute={},lastHourTimestamp=0,currentHour={})
    data['ownedCarsByType'] = {kind:sum(r['carsPerTrain']*40 for r in data['routes'] if r['trainType']==kind) for kind in TYPES}
    data['ownedTrainCount'] = sum(data['ownedCarsByType'].values())
    data['fareGroups'][0].update(routeIds=[r['id'] for r in data['routes']],flatFare=2.5)
    data['transitCost'] = 2.5
    save.update(id=str(uuid.uuid4()), gameSessionId=str(uuid.uuid4()), name='Japan Regional Railway - Tokyo to Kobe', timestamp=int(time.time()*1000),routeThumbnail='')
    save['metadata'] = dict(stations=len(data['stations']),routes=len(data['routes']),trains=0,money=data['money'],elapsedSeconds=18000)
    save['viewport'] = dict(longitude=139.747,latitude=35.69,zoom=11,bearing=0,pitch=0)
    output.parent.mkdir(parents=True,exist_ok=True); output.write_bytes(encode(blob,save))
    assert decode(output)[1]['mainSave'] == save
    report.update(save=str(output),sha256=hashlib.sha256(output.read_bytes()).hexdigest(),description=plan['description'])
    output.with_suffix('.report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))


if __name__ == '__main__': main()
