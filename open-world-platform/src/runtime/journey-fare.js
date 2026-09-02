const EARTH_RADIUS_METRES = 6_371_000;
const DEFAULT_TRANSFER_POLICY = 'free-within-group';
const DEFAULT_BOARDING_CHARGE = 1.5;
const DEFAULT_PER_KM_RATE = 0.15;
const DEFAULT_FARE_CAP = 6;

function distanceMetres(left, right) {
  const [lon1, lat1] = left.map((value) => value * Math.PI / 180);
  const [lon2, lat2] = right.map((value) => value * Math.PI / 180);
  const dLat = lat2 - lat1; const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_METRES * 2 * Math.asin(Math.sqrt(a));
}

function roundFare(value) { return Math.round(Math.round(value / 0.05) * 0.05 * 100) / 100; }
function roundMoney(value) { return Math.round(value * 1e12) / 1e12; }

function normalizedGroup(group) {
  let transferPolicy = group.transferPolicy;
  if (transferPolicy == null) transferPolicy = group.chargeOnInterGroupTransfer === false ? 'count-all-groups' : DEFAULT_TRANSFER_POLICY;
  if (group.fareSystem === 'route' && transferPolicy === 'free-within-group') transferPolicy = 'count-within-group';
  return {
    ...group,
    fareSystem: group.fareSystem ?? 'flat',
    transferPolicy,
    boardingCharge: group.boardingCharge ?? DEFAULT_BOARDING_CHARGE,
    perKmRate: group.perKmRate ?? DEFAULT_PER_KM_RATE,
    fareCap: group.fareCap ?? DEFAULT_FARE_CAP,
  };
}

function fareIndex(fareGroups, routes, legacyFare) {
  const groups = fareGroups?.length ? fareGroups : [{
    id: 'fare-group-default', fareSystem: 'flat', flatFare: legacyFare,
    routeFares: {}, routeIds: routes.filter((route) => !route.tempParentId).map((route) => route.id),
    transferPolicy: DEFAULT_TRANSFER_POLICY,
  }];
  const index = new Map();
  for (const rawGroup of groups) {
    const group = normalizedGroup(rawGroup);
    for (const routeId of group.routeIds ?? []) {
      index.set(routeId, {
        groupId: group.id,
        fareSystem: group.fareSystem,
        fare: group.fareSystem === 'route' ? group.routeFares?.[routeId] ?? group.flatFare : group.flatFare,
        transferPolicy: group.transferPolicy,
        boardingCharge: group.boardingCharge,
        perKmRate: group.perKmRate,
        fareCap: group.fareCap,
      });
    }
  }
  for (const route of routes ?? []) {
    if (route.tempParentId != null && index.has(route.tempParentId)) index.set(route.id, index.get(route.tempParentId));
  }
  return index;
}

function distanceFare(distanceKm, rule, boardingCharge = rule.boardingCharge) {
  let fare = boardingCharge + distanceKm * rule.perKmRate;
  if (rule.fareCap > 0) fare = Math.min(rule.fareCap, fare);
  return roundFare(fare);
}

/** Bundle-equivalent fare breakdown for route, flat, and distance groups. */
export function computeJourneyFareBreakdown(segments, fareGroups = [], routes = [], legacyFare = 0) {
  const index = fareIndex(fareGroups, routes, legacyFare);
  const states = new Map();
  const items = [];
  let encounteredPaidSegment = false;
  let total = 0;
  for (const segment of segments ?? []) {
    if (segment.isWalking || segment.isDriving || segment.routeId === 'walking') continue;
    const rule = index.get(segment.routeId) ?? {
      groupId: '__legacy', fareSystem: 'flat', fare: legacyFare,
      transferPolicy: DEFAULT_TRANSFER_POLICY, boardingCharge: 0, perKmRate: 0, fareCap: 0,
    };
    let state = states.get(rule.groupId);
    const firstInGroup = !state;
    if (!state) {
      state = {
        creditedEntry: encounteredPaidSegment && rule.transferPolicy === 'count-all-groups',
        creditUsed: false, flatPaid: false, paidRoutes: new Set(), distanceKm: 0, chargedTotal: 0,
      };
      states.set(rule.groupId, state);
    }
    encounteredPaidSegment = true;
    const item = { routeId: segment.routeId, groupId: rule.groupId, fareSystem: rule.fareSystem, amount: 0, kind: 'paid', firstInGroup };
    if (rule.fareSystem === 'flat') {
      if (rule.transferPolicy === 'all-paid') item.amount = rule.fare;
      else if (!state.flatPaid) {
        if (state.creditedEntry) item.kind = 'credited';
        else item.amount = rule.fare;
        state.flatPaid = true;
      } else item.kind = 'included';
    } else if (rule.fareSystem === 'route') {
      if (rule.transferPolicy === 'all-paid') item.amount = rule.fare;
      else if (!state.paidRoutes.has(segment.routeId)) {
        if (state.creditedEntry && !state.creditUsed) { state.creditUsed = true; item.kind = 'credited'; }
        else item.amount = rule.fare;
        state.paidRoutes.add(segment.routeId);
      } else item.kind = 'included';
    } else {
      const legKm = segment.fromStopCoords && segment.toStopCoords
        ? distanceMetres(segment.fromStopCoords, segment.toStopCoords) / 1_000
        : 0;
      item.legKm = legKm;
      item.perKmRate = rule.perKmRate;
      const boardingCharge = state.creditedEntry ? 0 : rule.boardingCharge;
      item.boardingCharge = boardingCharge;
      if (rule.transferPolicy === 'all-paid') {
        item.amount = distanceFare(legKm, rule);
      } else {
        state.distanceKm += legKm;
        const cumulative = distanceFare(state.distanceKm, rule, boardingCharge);
        item.amount = Math.max(0, cumulative - state.chargedTotal);
        state.chargedTotal = Math.max(state.chargedTotal, cumulative);
      }
    }
    total += item.amount;
    items.push(item);
  }
  return { total: Math.round(total * 100) / 100, items };
}

export function attributeJourneyFareByRoute(breakdown) {
  const result = {};
  const flatGroups = new Map();
  for (const item of breakdown.items ?? []) {
    if (item.fareSystem !== 'flat') continue;
    const aggregate = flatGroups.get(item.groupId) ?? { total: 0, count: 0 };
    aggregate.total += item.amount;
    aggregate.count++;
    flatGroups.set(item.groupId, aggregate);
  }
  for (const item of breakdown.items ?? []) {
    const amount = item.fareSystem === 'flat'
      ? (flatGroups.get(item.groupId)?.total ?? 0) / Math.max(1, flatGroups.get(item.groupId)?.count ?? 0)
      : item.amount;
    if (!(amount > 0)) continue;
    result[item.routeId] = roundMoney((result[item.routeId] ?? 0) + amount);
  }
  return result;
}

/** Build native fare segments from the route/station paths cached by the router. */
export function fareSegmentsFromStationRoutes(stationRoutes, stationById) {
  const lookup = stationById instanceof Map
    ? stationById
    : new Map(Object.entries(stationById ?? {}));
  const segments = [];
  for (const route of stationRoutes ?? []) {
    const stationIds = route.stationIds ?? [];
    const from = lookup.get(stationIds[0]);
    const to = lookup.get(stationIds[stationIds.length - 1]);
    if (!route.routeId || !from?.coords || !to?.coords) continue;
    segments.push({ routeId: route.routeId, fromStopCoords: [...from.coords], toStopCoords: [...to.coords] });
  }
  return segments;
}

/** Prefer the public native total, scaling the exact route breakdown to it. */
export function quoteJourneyFare({ segments, fareGroups = [], routes = [], legacyFare = 0, nativeFare = null }) {
  const breakdown = computeJourneyFareBreakdown(segments, fareGroups, routes, legacyFare);
  const nativeTotal = typeof nativeFare === 'function' ? nativeFare(segments) : null;
  const total = Number.isFinite(nativeTotal) && nativeTotal >= 0 ? nativeTotal : breakdown.total;
  const rawAttribution = attributeJourneyFareByRoute(breakdown);
  const rawTotal = Object.values(rawAttribution).reduce((sum, value) => sum + value, 0);
  const revenueByRoute = {};
  if (rawTotal > 0) {
    for (const [routeId, amount] of Object.entries(rawAttribution)) revenueByRoute[routeId] = roundMoney(amount * total / rawTotal);
  } else if (total > 0 && segments?.[0]?.routeId) revenueByRoute[segments[0].routeId] = total;
  return { total, revenueByRoute, breakdown };
}
