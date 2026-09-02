import { performance } from 'node:perf_hooks';
import { calculateCrossTileModeShares, createNetworkProfile } from '../../../../open-world-platform/src/runtime/cross-tile-mode-choice.js';

const stationCount = Number(process.env.STATIONS ?? 400);
const popCount = Number(process.env.POPS ?? 6_125);
const tileCount = Number(process.env.TILES ?? 7);
const endpointPointCount = Number(process.env.ENDPOINT_POINTS ?? 1);
const west = -74.7;
const east = -74.0;
const latitude = 41.5;

const stationRows = Array.from({ length: stationCount }, (_, index) => {
  const longitude = west + (east - west) * index / (stationCount - 1);
  return [`station-${index}`, [longitude, latitude], `node-${index}`];
});
const stations = stationRows.map(([id, coords, nodeId]) => ({
  id, coords, stNodeIds: [nodeId], nearbyStations: [], buildType: 'constructed',
}));
const network = createNetworkProfile({
  tileId: 'T0',
  stations,
  routes: [{ id: 'corridor', tempParentId: null, stNodes: stationRows.map(([, , id]) => ({ id })) }],
  trains: [{ id: 'train', routeId: 'corridor' }],
});

const width = (east - west) / tileCount;
const tiles = Array.from({ length: tileCount }, (_, index) => ({
  id: `T${index}`,
  bounds: [west + width * index, latitude - 0.1, west + width * (index + 1), latitude + 0.1],
  neighbors: [index > 0 && { tileId: `T${index - 1}` }, index + 1 < tileCount && { tileId: `T${index + 1}` }].filter(Boolean),
}));
const homePoints = Array.from({ length: endpointPointCount }, (_, index) => [
  `home-${index}`,
  west + width * 0.8 * (index + 0.5) / endpointPointCount,
  latitude,
  'T0',
  0,
  0,
]);
const workPoints = Array.from({ length: endpointPointCount }, (_, index) => [
  `work-${index}`,
  east - width * 0.8 * (index + 0.5) / endpointPointCount,
  latitude,
  `T${tileCount - 1}`,
  0,
  0,
]);
const crossDemand = {
  schemaVersion: 1,
  gateways: ['pair'],
  points: [...homePoints, ...workPoints],
  pops: Array.from({ length: popCount }, (_, index) => [
    `pop-${index}`, 50,
    index % endpointPointCount,
    endpointPointCount + (index * 37) % endpointPointCount,
    0,
  ]),
};
const common = {
  crossDemand,
  networkProfiles: { T0: network },
  gatewayCatalog: { pair: { id: 'pair', location: [(west + east) / 2, latitude] } },
  fare: 0,
};

function run(tileCatalog) {
  const started = performance.now();
  const result = calculateCrossTileModeShares({ ...common, tileCatalog });
  return { milliseconds: performance.now() - started, result };
}

run(undefined);
run({ tiles });
const baseline = run(undefined);
const cached = run({ tiles });
const speedup = baseline.milliseconds / cached.milliseconds;

console.log(JSON.stringify({
  stations: stationCount,
  populations: popCount,
  endpointPointsPerSide: endpointPointCount,
  tiles: tileCount,
  baselineMilliseconds: Math.round(baseline.milliseconds * 10) / 10,
  cachedMilliseconds: Math.round(cached.milliseconds * 10) / 10,
  speedup: Math.round(speedup * 100) / 100,
  routingStats: cached.result.routingStats,
  sameEvaluatedPopulationCount: baseline.result.evaluatedPops === cached.result.evaluatedPops,
}, null, 2));
