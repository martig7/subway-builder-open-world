const VIEW_FIELDS = Object.freeze({ residents: 'residents', workers: 'workers' });
const MODE_KEYS = Object.freeze(['driving', 'walking', 'transit']);

function emptyModes() { return { driving: 0, walking: 0, transit: 0 }; }
function addModes(target, source) { for (const key of MODE_KEYS) target[key] += source[key] ?? 0; }

function normalizedModes(modeChoice, mass) {
  if (!modeChoice) return emptyModes();
  const total = MODE_KEYS.reduce((sum, key) => sum + (modeChoice?.[key] ?? 0), modeChoice.unknown ?? 0);
  if (!(total > 0)) return emptyModes();
  return Object.fromEntries(MODE_KEYS.map((key) => [key, mass * (modeChoice?.[key] ?? 0) / total]));
}

function modeRatios(modeChoice) {
  const total = MODE_KEYS.reduce((sum, key) => sum + (modeChoice[key] ?? 0), 0);
  return total > 0
    ? Object.fromEntries(MODE_KEYS.map((key) => [key, (modeChoice[key] ?? 0) / total]))
    : { driving: 0, walking: 0, transit: 0 };
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

const GREAT_CIRCLE_SEGMENTS = 12;
const toRadians = (degrees) => degrees * Math.PI / 180;
const toDegrees = (radians) => radians * 180 / Math.PI;

function greatCircleCoordinates(start, end, segmentCount = GREAT_CIRCLE_SEGMENTS) {
  const [startLongitude, startLatitude] = start;
  const [endLongitude, endLatitude] = end;
  const startLongitudeRadians = toRadians(startLongitude);
  const startLatitudeRadians = toRadians(startLatitude);
  const endLongitudeRadians = toRadians(endLongitude);
  const endLatitudeRadians = toRadians(endLatitude);
  const startVector = [
    Math.cos(startLatitudeRadians) * Math.cos(startLongitudeRadians),
    Math.cos(startLatitudeRadians) * Math.sin(startLongitudeRadians),
    Math.sin(startLatitudeRadians),
  ];
  const endVector = [
    Math.cos(endLatitudeRadians) * Math.cos(endLongitudeRadians),
    Math.cos(endLatitudeRadians) * Math.sin(endLongitudeRadians),
    Math.sin(endLatitudeRadians),
  ];
  const dot = Math.max(-1, Math.min(1,
    startVector[0] * endVector[0] + startVector[1] * endVector[1] + startVector[2] * endVector[2]));
  const angularDistance = Math.acos(dot);
  const sinAngularDistance = Math.sin(angularDistance);

  const coordinates = [start];
  for (let index = 1; index < segmentCount; index++) {
    const fraction = index / segmentCount;
    if (angularDistance < 1e-12 || Math.abs(sinAngularDistance) < 1e-12) {
      coordinates.push([
        startLongitude + (endLongitude - startLongitude) * fraction,
        startLatitude + (endLatitude - startLatitude) * fraction,
      ]);
      continue;
    }
    const startWeight = Math.sin((1 - fraction) * angularDistance) / sinAngularDistance;
    const endWeight = Math.sin(fraction * angularDistance) / sinAngularDistance;
    const x = startWeight * startVector[0] + endWeight * endVector[0];
    const y = startWeight * startVector[1] + endWeight * endVector[1];
    const z = startWeight * startVector[2] + endWeight * endVector[2];
    coordinates.push([toDegrees(Math.atan2(y, x)), toDegrees(Math.atan2(z, Math.hypot(x, y)))]);
  }
  coordinates.push(end);
  return coordinates;
}

export function modeShareColor(modeChoice) {
  const ratios = modeRatios(modeChoice);
  if (MODE_KEYS.every((key) => ratios[key] === 0)) return '#646464';
  return rgbToHex([ratios.driving * 255, ratios.walking * 255, ratios.transit * 255]);
}

export function demandPointRadius(population, viewMode = 'residents') {
  if (!(population > 0)) return 0;
  // Match the game's normal (non-experimental) demand bubble curve. Radius is
  // proportional to sqrt(population), so the circle's area represents mass.
  // Native worker bubbles use a smaller multiplier than resident bubbles.
  const scale = viewMode === 'workers' ? 2.5 : 6.5;
  return Math.sqrt(population / Math.PI) * scale;
}

export class CrossDemandModel {
  constructor(raw, gatewayLedger = {}, popModeChoices = {}) {
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.points) || !Array.isArray(raw.pops)) {
      throw new Error('Unsupported cross-demand data');
    }
    this.gateways = raw.gateways ?? [];
    this.rawPops = raw.pops;
    this.popModeChoices = popModeChoices ?? {};
    this.flowModes = new Map();
    for (const entry of Object.values(gatewayLedger)) {
      const flow = entry.flow;
      if (!flow) continue;
      this.flowModes.set(`${flow.homeTileId}|${flow.workTileId}|${flow.gatewayId}`, entry.modeChoice);
    }
    this.points = raw.points.map(([id, longitude, latitude, tileId, residents, workers], index) => ({
      id, index, location: [longitude, latitude], tileId, residents, workers,
      residentModes: emptyModes(), workerModes: emptyModes(), homePops: [], workPops: [],
    }));
    this.pointById = new Map(this.points.map((point) => [point.id, point]));
    this.rawPops.forEach((pop, popIndex) => {
      const [, mass, homeIndex, workIndex] = pop;
      const modes = this.#popModes(pop);
      this.points[homeIndex].homePops.push(popIndex);
      this.points[workIndex].workPops.push(popIndex);
      addModes(this.points[homeIndex].residentModes, modes);
      addModes(this.points[workIndex].workerModes, modes);
      if (!(mass >= 0)) throw new Error(`Invalid cross-demand pop mass: ${pop[0]}`);
    });
  }

  #popModes([id, mass, homeIndex, workIndex, gatewayIndex]) {
    const exact = this.popModeChoices[id];
    if (exact) return normalizedModes(exact, mass);
    const home = this.points[homeIndex];
    const work = this.points[workIndex];
    const gatewayId = this.gateways[gatewayIndex];
    return normalizedModes(this.flowModes.get(`${home.tileId}|${work.tileId}|${gatewayId}`), mass);
  }

  pointFeatures(viewMode, selectedId = null) {
    const massField = VIEW_FIELDS[viewMode] ?? VIEW_FIELDS.residents;
    const modeField = viewMode === 'workers' ? 'workerModes' : 'residentModes';
    return {
      type: 'FeatureCollection',
      features: this.points
        .filter((point) => point[massField] > 0 && (!selectedId || point.id === selectedId))
        .map((point) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point.location },
        properties: {
          id: point.id,
          population: point[massField],
          baseRadius: selectedId === point.id ? 80 : demandPointRadius(point[massField], viewMode),
          color: modeShareColor(point[modeField]),
          selected: selectedId === point.id,
        },
        })),
    };
  }

  pointDetails(pointId, viewMode, offset = 0, limit = 40) {
    const point = this.pointById.get(pointId);
    if (!point) return null;
    const popIndexes = viewMode === 'workers' ? point.workPops : point.homePops;
    const modes = viewMode === 'workers' ? point.workerModes : point.residentModes;
    return {
      point,
      population: viewMode === 'workers' ? point.workers : point.residents,
      modeChoice: modes,
      popCount: popIndexes.length,
      pops: popIndexes.slice(offset, offset + limit).map((index) => this.popDetails(index)),
    };
  }

  popDetails(popIndex) {
    const pop = this.rawPops[popIndex];
    if (!pop) return null;
    const [id, mass, homeIndex, workIndex, gatewayIndex] = pop;
    return {
      index: popIndex, id, mass,
      home: this.points[homeIndex], work: this.points[workIndex],
      gatewayId: this.gateways[gatewayIndex],
      modeChoice: this.#popModes(pop),
    };
  }

  connections(pointId, viewMode) {
    const point = this.pointById.get(pointId);
    if (!point) return { type: 'FeatureCollection', features: [] };
    const indexes = viewMode === 'workers' ? point.workPops : point.homePops;
    const grouped = new Map();
    for (const popIndex of indexes) {
      const pop = this.rawPops[popIndex];
      const targetIndex = viewMode === 'workers' ? pop[2] : pop[3];
      const group = grouped.get(targetIndex) ?? { mass: 0, modes: emptyModes() };
      group.mass += pop[1];
      addModes(group.modes, this.#popModes(pop));
      grouped.set(targetIndex, group);
    }
    const endpointKind = viewMode === 'workers' ? 'home' : 'work';
    return {
      type: 'FeatureCollection',
      features: Array.from(grouped).flatMap(([targetIndex, group]) => {
        const target = this.points[targetIndex];
        const color = modeShareColor(group.modes);
        return [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: greatCircleCoordinates(point.location, target.location) },
            properties: { kind: 'connection', mass: group.mass, color },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: target.location },
            properties: {
              kind: endpointKind, id: target.id, mass: group.mass, color,
              view: 'per-point-endpoint',
            },
          },
        ];
      }),
    };
  }

  popSelection(popIndex, drivingPath = null) {
    const pop = this.popDetails(popIndex);
    if (!pop) return { type: 'FeatureCollection', features: [] };
    const coordinates = Array.isArray(drivingPath) && drivingPath.length >= 2
      ? drivingPath
      : greatCircleCoordinates(pop.home.location, pop.work.location);
    return {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { kind: 'pop-line', mass: pop.mass, color: '#ff0000' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: pop.home.location }, properties: { kind: 'home', color: '#ffffff' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: pop.work.location }, properties: { kind: 'work', color: '#ff5959' } },
      ],
    };
  }

  get stats() {
    return {
      points: this.points.length,
      pops: this.rawPops.length,
      population: this.rawPops.reduce((sum, pop) => sum + pop[1], 0),
    };
  }
}
