const POP_FIELDS = ['id', 'mass', 'homePoint', 'workPoint', 'gateway', 'homeDepartureTime',
  'workDepartureTime', 'drivingSeconds', 'drivingDistance', 'tripType'];
const encode = value => encodeURIComponent(String(value));
export const isExtensionCrossPopId = id => typeof id === 'string' && id.startsWith('extension-cross:');
const endpointKey = endpoint => JSON.stringify([endpoint.tileId, endpoint.id]);

/** Project selected immutable extension records into the existing cross-demand schema.
 * Endpoint stock is calculated from cohorts once; native-only overlay arrays stay out.
 */
export function projectCrossDemandExtensions(base, records = [], revisionKey = null) {
  const active = records.filter(record => record.payload?.crossPops?.length);
  if (!active.length) return base ? { ...base, extensionFlows: [], extensionPopIds: [], crossExtensionKey: revisionKey } : null;
  const source = base ?? { schemaVersion: 1, points: [], pops: [], gateways: [], popFields: POP_FIELDS };
  const points = [...source.points], pops = [...source.pops], gateways = [...(source.gateways ?? [])];
  // Retain packaged tuples. Only the sparse endpoints referenced by owned
  // records need an index or a writable copy, even in a country-sized catalog.
  const wanted = new Map(), pointIndex = new Map(), copiedPoints = new Set();
  for (const record of active) for (const endpoint of record.payload.endpoints ?? []) {
    const owners = wanted.get(endpoint.id) ?? new Set(); owners.add(endpoint.tileId); wanted.set(endpoint.id, owners);
  }
  for (let index = 0; index < source.points.length; index++) {
    const point = source.points[index];
    if (wanted.get(point[0])?.has(point[3])) pointIndex.set(JSON.stringify([point[3], point[0]]), index);
  }
  const gatewayIndex = new Map(gateways.map((id, index) => [id, index]));
  const staticGateways = new Set(gateways);
  const flows = new Map(), owners = new Map(), popIds = new Set(), extensionPopIds = [];
  for (const record of active.sort((a, b) => `${a.tileId}\0${a.extensionId}`.localeCompare(`${b.tileId}\0${b.extensionId}`))) {
    const owner = JSON.stringify([record.tileId, record.extensionId]);
    const previous = owners.get(owner);
    if (previous) {
      if (JSON.stringify(previous.payload) !== JSON.stringify(record.payload)) throw new Error('Conflicting cross-demand owner records');
      continue;
    }
    owners.set(owner, record);
    const endpoints = new Map((record.payload.endpoints ?? []).map(endpoint => [endpoint.id, endpoint]));
    const addEndpoint = endpoint => {
      if (!endpoint?.tileId || !Array.isArray(endpoint.location) || endpoint.location.length !== 2
        || !endpoint.location.every(Number.isFinite)) throw new Error('Invalid cross-demand endpoint');
      const key = endpointKey(endpoint);
      let index = pointIndex.get(key);
      if (index == null) {
        index = points.length;
        points.push([`extension-point:${encode(endpoint.tileId)}:${encode(endpoint.id)}`,
          ...endpoint.location, endpoint.tileId, 0, 0]);
        pointIndex.set(key, index);
      } else if (points[index][1] !== endpoint.location[0] || points[index][2] !== endpoint.location[1]) {
        throw new Error('Cross-demand endpoint location conflicts with its owner');
      }
      if (index < source.points.length && !copiedPoints.has(index)) {
        points[index] = [...points[index]]; copiedPoints.add(index);
      }
      return index;
    };
    for (const pop of record.payload.crossPops) {
      if (!Number.isFinite(pop.size) || !(pop.size > 0)) throw new Error('Invalid cross-demand cohort mass');
      const home = endpoints.get(pop.residenceId), work = endpoints.get(pop.jobId);
      if (!home || !work) throw new Error('Cross-demand cohort endpoint is unavailable');
      if (home.tileId === record.tileId && work.tileId === record.tileId) throw new Error('Local demand cannot enter cross accounting');
      const homeIndex = addEndpoint(home), workIndex = addEndpoint(work);
      const id = `extension-cross:${encode(record.tileId)}:${encode(record.extensionId)}:${encode(pop.id)}`;
      if (popIds.has(id)) throw new Error('Duplicate projected cross-demand cohort');
      popIds.add(id);
      extensionPopIds.push(id);
      const gatewayId = `extension:${encode(home.tileId)}|${encode(work.tileId)}`;
      if (staticGateways.has(gatewayId)) throw new Error('Extension gateway collides with packaged demand');
      if (!gatewayIndex.has(gatewayId)) { gatewayIndex.set(gatewayId, gateways.length); gateways.push(gatewayId); }
      points[homeIndex][4] = (Number(points[homeIndex][4]) || 0) + pop.size;
      points[workIndex][5] = (Number(points[workIndex][5]) || 0) + pop.size;
      pops.push([id, pop.size, homeIndex, workIndex, gatewayIndex.get(gatewayId), pop.homeDepartureTime,
        pop.workDepartureTime, pop.drivingSeconds, pop.drivingDistance, 'commute']);
      const flow = flows.get(gatewayId) ?? { id: gatewayId, homeTileId: home.tileId, workTileId: work.tileId,
        gatewayId, mass: 0, travelHours: 1, extension: true };
      flow.mass += pop.size; flows.set(gatewayId, flow);
    }
  }
  for (const pop of source.pops) if (popIds.has(pop[0])) throw new Error('Extension cohort collides with packaged demand');
  return { ...source, points, pops, gateways, popFields: source.popFields?.length ? source.popFields : POP_FIELDS,
    extensionFlows: [...flows.values()], extensionPopIds, crossExtensionKey: revisionKey };
}
