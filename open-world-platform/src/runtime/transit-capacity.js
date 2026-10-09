import { nextServiceDeparture } from './scheduled-transit-service.js';

export const TRANSIT_CAPACITY_VERSION = 'scheduled-segment-capacity-v1';
const MAX_SEGMENT_RESERVATIONS = 500000;
const routeVersion = route => JSON.stringify([route.stNodeIds, route.stComboTimings,
  route.configuredServiceCount ?? route.serviceCount, route.timetableSchedule, route.capacityPerTrain]);
export function capacityRouteVersions(profiles) {
  const versions = {};
  for (const p of Object.values(profiles ?? {})) for (const r of p?.routes ?? []) versions[r.id] = routeVersion(r);
  return versions;
}

/** A seat belongs to one vehicle departure and directed route segment. Offers
 * are atomic across transfers; inspection never consumes seats. Unknown legacy
 * profiles remain routable, but report their missing capacity explicitly. */
export function createTransitCapacityLedger({ networkProfiles = {}, reservations = [] } = {}) {
  const routes = new Map();
  for (const p of Object.values(networkProfiles)) for (const r of p?.routes ?? []) {
    if (!routes.has(r.id) || (r.stNodeIds?.length ?? 0) > (routes.get(r.id).stNodeIds?.length ?? 0)) routes.set(r.id, { ...r, serviceCount: r.configuredServiceCount ?? r.serviceCount });
  }
  const loads = new Map(), own = new Map();
  const dailyOrigin = origin => Math.round((((origin % 86400) + 86400) % 86400) * 1000) / 1000;
  const keyOf = (id, origin, index) => JSON.stringify([id, dailyOrigin(origin), index]);
  for (const [id, origin, index, people] of reservations) {
    const key = keyOf(id, origin, index);
    loads.set(key, (loads.get(key) ?? 0) + people);
  }
  const stats = { version: TRANSIT_CAPACITY_VERSION, queuedPeople: 0, carriedPeople: 0,
    unservedPeople: 0, unknownCapacityRoutes: [...routes.values()].filter(r => !(r.capacityPerTrain > 0)).map(r => r.id) };
  function offer(segments, after = new Map()) {
    const bookings = [], departureTimes = [];
    let delay = 0, seats = Infinity, previous = null, blockedRouteId = null;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i], r = routes.get(s.routeId);
      if (s.isWalking || s.isDriving || !r || !(r.capacityPerTrain > 0) || !Number.isFinite(s.capacitySegmentIndex)) {
        departureTimes.push(s.departureTime + delay); previous = null; continue;
      }
      const duration = s.arrivalTime - s.departureTime;
      const continuing = previous?.routeId === s.routeId && previous.index + 1 === s.capacitySegmentIndex;
      let departure = continuing ? previous.origin + s.serviceOffsetSeconds
        : nextServiceDeparture(r, s.serviceOffsetSeconds, s.departureTime + delay);
      if (after.has(i)) departure = nextServiceDeparture(r, s.serviceOffsetSeconds, Math.max(s.departureTime + delay, after.get(i) + 0.001));
      // No overnight carry-over: this is a recurring daily forecast, not an
      // unbounded promise to complete yesterday's queue on a future day.
      if (departure == null || departure >= (Math.floor(s.departureTime / 86400) + 1) * 86400) return null;
      delay = Math.max(delay, departure - s.departureTime);
      const origin = departure - s.serviceOffsetSeconds;
      const key = keyOf(s.routeId, origin, s.capacitySegmentIndex);
      const free = Math.max(0, Math.floor(r.capacityPerTrain - (loads.get(key) ?? 0)));
      if (free < seats) { seats = free; blockedRouteId = s.routeId; }
      bookings.push({ key, row: [s.routeId, dailyOrigin(origin), s.capacitySegmentIndex], index: i, departure });
      departureTimes.push(departure);
      previous = { routeId: s.routeId, origin, index: s.capacitySegmentIndex, arrival: departure + duration };
    }
    return { seats, queueSeconds: delay, departureTimes, bookings, blockedRouteId };
  }
  function nextOffer(segments) {
    const after = new Map();
    let candidate = offer(segments, after);
    // At most one daily departure per second. Usually this loop skips only a
    // few occupied trains; its work is bounded by the reservation ledger.
    for (let attempts = 0; candidate && candidate.seats === 0 && attempts < 86400; attempts++) {
      const blocked = candidate.bookings.find(b => (loads.get(b.key) ?? 0) >= routes.get(b.row[0]).capacityPerTrain);
      if (!blocked) return null;
      let boarding = blocked.index;
      while (boarding > 0 && segments[boarding - 1].routeId === segments[boarding].routeId
        && segments[boarding - 1].capacitySegmentIndex + 1 === segments[boarding].capacitySegmentIndex) boarding--;
      after.set(boarding, blocked.departure - segments[blocked.index].serviceOffsetSeconds + segments[boarding].serviceOffsetSeconds);
      candidate = offer(segments, after);
    }
    return candidate?.seats > 0 ? candidate : null;
  }
  return { stats, nextOffer,
    commit(offer, mass) {
      if (!(mass > 0) || mass > offer.seats) throw new Error('Invalid transit seat reservation');
      const newKeys = new Set(offer.bookings.filter(b => !loads.has(b.key)).map(b=>b.key));
      if (loads.size + newKeys.size > MAX_SEGMENT_RESERVATIONS) throw new Error('Transit capacity ledger limit reached');
      for (const b of offer.bookings) {
        loads.set(b.key, (loads.get(b.key) ?? 0) + mass);
        const prior = own.get(b.key);
        own.set(b.key, [...b.row, (prior?.[3] ?? 0) + mass]);
      }
      stats.carriedPeople += mass;
      if (offer.queueSeconds > 0) stats.queuedPeople += mass;
    },
    reservations: () => [...own.values()],
  };
}

// The host owns this disposable session budget. Workers receive a compact
// snapshot excluding their own previous result, then replace that result only
// on success. Native tiles and cross demand therefore cannot reuse the seats.
const STATE = Symbol.for('open-world.transit-capacity-budget');
function budgetState() {
  if (globalThis[STATE]?.version !== TRANSIT_CAPACITY_VERSION) globalThis[STATE] = { version: TRANSIT_CAPACITY_VERSION, scope: null, epoch: 0, sources: new Map() };
  return globalThis[STATE];
}
export function beginCapacityEvaluation(input, source = `native:${input.tileId}`) {
  const state = budgetState(), scope = input.capacityScope ?? input.worldId;
  if (scope !== state.scope) { state.scope = scope; state.epoch++; state.sources.clear(); }
  const profiles = input.networkProfiles ?? { [input.tileId]: input.networkProfile };
  const versions = capacityRouteVersions(profiles), reservations = [];
  for (const [id, data] of state.sources) if (id !== source) for (const row of data.reservations) {
    if (versions[row[0]] === data.versions[row[0]]) reservations.push(row);
  }
  const epoch = state.epoch;
  const packet = { ...input, capacityBudget: { version: TRANSIT_CAPACITY_VERSION, reservations } };
  return { input: packet, commit(result) {
    if (state.scope !== scope || state.epoch !== epoch) return;
    const data = result?.profile ?? result;
    if (Array.isArray(data?.capacityReservations)) state.sources.set(source, { versions, reservations: data.capacityReservations });
  } };
}
