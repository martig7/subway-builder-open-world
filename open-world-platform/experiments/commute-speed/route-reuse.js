// Experimental route-menu reuse. This reduces the number of graph searches by
// accepting a feasible cached topology, not by claiming it remains optimal.
// Menus retain only bounded edge references; all times are replayed afresh.
const emptySearchStats = () => ({ relaxedEdges: 0, settledStates: 0, createdLabels: 0, corridorEdges: 0 });
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

function nextDeparture(edge, ready) {
  const route = edge.route;
  let headway = route.cycleTimeSeconds > 0 && route.serviceCount > 0
    ? route.cycleTimeSeconds / route.serviceCount : 0;
  if (route.timetableSchedule?.mode === 'timetable') {
    const hour = ((ready % 86_400) + 86_400) % 86_400 / 3_600;
    const period = route.timetableSchedule.periods?.find(item => {
      const start = finite(item.startHour, 0), end = finite(item.endHour, 24);
      return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    });
    headway = Math.max(0, finite(period?.headwaySeconds, 0));
  }
  if (!(headway > 0)) return null;
  const phases = route.departureAnchorsByNode?.[edge.departureNodeId];
  if (phases?.length && route.cycleTimeSeconds > 0) {
    let next = Infinity;
    for (const phase of phases) next = Math.min(next,
      phase + Math.max(0, Math.ceil((ready - phase) / route.cycleTimeSeconds)) * route.cycleTimeSeconds);
    return Number.isFinite(next) ? next : null;
  }
  return edge.departureOffsetSeconds
    + Math.max(0, Math.ceil((ready - edge.departureOffsetSeconds) / headway)) * headway;
}

/** Replay a topology using the same boarding, dwell and cost rules as the router.
 * May join/leave along its path, but never invents an edge or a train departure.
 * Returns null if no permitted access/egress combination is feasible below bound.
 * The extra cost/clock fields are diagnostics, ignored by the production caller.
 */
export function replayRouteCandidate(candidate, query, { maxReplayStarts = 3 } = {}) {
  const { starts, ends, rules, requestedDepartureSeconds } = query;
  const bound = query.bound ?? Infinity;
  const walkWeight = rules.PERCEIVED_TIME.WALK_MULTIPLIER;
  const byId = new Map(starts);
  let best = null, bestCost = bound, replayedEdges = 0, attemptedStarts = 0;
  // The original source is first. Joining later also supports nearby catchments
  // whose shared nearest-station key is unchanged but original access is absent.
  for (let startIndex = 0; startIndex <= candidate.edges.length; startIndex++) {
    const id = startIndex ? candidate.edges[startIndex - 1].to : candidate.sourceStationId;
    const access = byId.get(id);
    if (!access) continue;
    if (++attemptedStarts > maxReplayStarts) break;
    let actual = requestedDepartureSeconds + access.seconds;
    let cost = access.seconds * (access.mode === 'drive' ? 1 : walkWeight);
    let station = id, routeState = null, boarded = false;
    for (let index = startIndex; index <= candidate.edges.length; index++) {
      const egress = ends.get(station);
      if (egress != null && (boarded || access.mode !== 'drive')) {
        const total = cost + egress * walkWeight;
        if (total < bestCost) {
          bestCost = total;
          best = { available: true, source: [id, access], egressWalkSeconds: egress,
            edges: candidate.edges.slice(startIndex, index), perceivedSeconds: total,
            totalClockSeconds: actual - requestedDepartureSeconds + egress, stats: emptySearchStats() };
        }
      }
      if (index === candidate.edges.length || cost >= bestCost) break;
      const edge = candidate.edges[index];
      replayedEdges++;
      if (edge.type === 'walk') {
        actual += edge.seconds;
        cost += edge.seconds * walkWeight;
        routeState = null;
      } else {
        let departure, shift, wait, vehicle;
        if (routeState === edge.routeStateId) {
          departure = actual + edge.dwellSeconds;
          shift = 0; wait = 0; vehicle = edge.dwellSeconds + edge.inVehicleSeconds;
        } else {
          const gap = boarded ? 0 : rules.ARRIVAL_GAP;
          departure = nextDeparture(edge, actual + gap);
          if (departure == null) break;
          shift = boarded ? 0 : Math.max(0, departure - gap - actual);
          wait = boarded ? Math.max(0, departure - actual) : gap;
          vehicle = edge.inVehicleSeconds;
        }
        cost += shift * rules.PERCEIVED_TIME.DEPARTURE_SHIFT_MULTIPLIER
          + wait * rules.PERCEIVED_TIME.WAIT_MULTIPLIER + vehicle;
        actual = departure + edge.inVehicleSeconds;
        routeState = edge.routeStateId;
        boarded = true;
      }
      station = edge.to;
    }
  }
  return { result: best, replayedEdges };
}

function nearest(items, secondsOf) {
  let id = null, best = Infinity;
  for (const [candidateId, value] of items) {
    const seconds = secondsOf(value);
    if (seconds < best || (seconds === best && String(candidateId) < String(id))) {
      id = candidateId; best = seconds;
    }
  }
  return id;
}

/** Bounded approximate wrapper around createWasmTransitSearch's kernel API.
 * Router identity owns invalidation, matching the immutable router snapshots
 * built by createCrossTileRoutingCache after graph/service/rule/World changes.
 * auditEvery runs and returns the exact baseline every Nth feasible reuse and
 * records candidate cost error. Zero disables this extra audit work.
 */
export function createRouteReuseSearch(baseKernel, {
  maxEntries = 4096, maxCandidates = 2, maxRetainedEdges = 200_000,
  maxCandidateEdges = 512, maxReplayStarts = 3, bucketSeconds = 0,
  auditEvery = 0,
} = {}) {
  for (const [name, value] of Object.entries({ maxEntries, maxCandidates, maxRetainedEdges, maxCandidateEdges, maxReplayStarts })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (!Number.isFinite(bucketSeconds) || bucketSeconds < 0) throw new RangeError('bucketSeconds must be nonnegative');
  if (!Number.isInteger(auditEvery) || auditEvery < 0) throw new RangeError('auditEvery must be a nonnegative integer');
  const menus = new Map();
  let previousRouter = null, retainedEdges = 0;
  const stats = { queries: 0, hits: 0, misses: 0, exactSearches: 0, audits: 0,
    auditWorse: 0, auditCostErrorSeconds: 0, auditMaximumCostErrorSeconds: 0,
    replayedEdges: 0, candidatesRejected: 0, evictions: 0, resets: 0,
    retainedMenus: 0, retainedEdges: 0, peakRetainedEdges: 0, peakRetainedMenus: 0 };
  const publishSize = () => {
    stats.retainedMenus = menus.size; stats.retainedEdges = retainedEdges;
    stats.peakRetainedMenus = Math.max(stats.peakRetainedMenus, menus.size);
    stats.peakRetainedEdges = Math.max(stats.peakRetainedEdges, retainedEdges);
  };
  function evict(key) {
    const menu = menus.get(key);
    if (!menu) return;
    for (const candidate of menu.candidates) retainedEdges -= candidate.edges.length;
    menus.delete(key); stats.evictions++;
  }
  function retain(key, result) {
    if (!result?.available || result.edges.length > maxCandidateEdges || result.edges.length > maxRetainedEdges) return;
    let menu = menus.get(key);
    if (!menu) { menu = { candidates: [] }; menus.set(key, menu); }
    const sourceStationId = result.source[0];
    if (!menu.candidates.some(item => item.sourceStationId === sourceStationId
      && item.edges.length === result.edges.length && item.edges.every((edge, index) => edge === result.edges[index]))) {
      if (menu.candidates.length === maxCandidates) retainedEdges -= menu.candidates.shift().edges.length;
      menu.candidates.push({ sourceStationId, edges: result.edges.slice() });
      retainedEdges += result.edges.length;
    }
    menus.delete(key); menus.set(key, menu);
    while (menus.size > maxEntries || retainedEdges > maxRetainedEdges) evict(menus.keys().next().value);
    publishSize();
  }
  return {
    stats,
    clear() { menus.clear(); retainedEdges = 0; previousRouter = null; publishSize(); },
    search(router, query) {
      stats.queries++;
      if (previousRouter !== router) {
        menus.clear(); retainedEdges = 0; previousRouter = router; stats.resets++; publishSize();
      }
      const origin = nearest(query.starts, access => access.seconds);
      const destination = nearest(query.ends, seconds => seconds);
      const band = bucketSeconds ? Math.floor(query.requestedDepartureSeconds / bucketSeconds) : 0;
      const key = JSON.stringify([origin, destination, band]);
      const menu = menus.get(key);
      let candidate = null;
      if (menu) {
        menus.delete(key); menus.set(key, menu);
        for (const topology of menu.candidates) {
          const replay = replayRouteCandidate(topology, { ...query,
            bound: candidate?.perceivedSeconds ?? query.bound ?? Infinity }, { maxReplayStarts });
          stats.replayedEdges += replay.replayedEdges;
          if (replay.result) candidate = replay.result;
          else stats.candidatesRejected++;
        }
      }
      if (candidate) {
        stats.hits++;
        if (!auditEvery || stats.hits % auditEvery) return candidate;
        stats.audits++;
      } else stats.misses++;
      stats.exactSearches++;
      const result = baseKernel.search(router, query);
      if (candidate && result?.available) {
        const exact = replayRouteCandidate({ sourceStationId: result.source[0], edges: result.edges }, {
          ...query, starts: [result.source], ends: new Map([[result.edges.at(-1)?.to ?? result.source[0], result.egressWalkSeconds]]),
          bound: Infinity,
        }, { maxReplayStarts: 1 }).result;
        if (exact) {
          const error = Math.max(0, candidate.perceivedSeconds - exact.perceivedSeconds);
          stats.auditCostErrorSeconds += error;
          stats.auditMaximumCostErrorSeconds = Math.max(stats.auditMaximumCostErrorSeconds, error);
          if (error > 1e-7) stats.auditWorse++;
        }
      }
      retain(key, result);
      return result;
    },
  };
}
