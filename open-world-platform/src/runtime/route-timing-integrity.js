const clone = (value) => value === undefined ? undefined : structuredClone(value);

const nodeId = (node) => node?.id == null ? null : String(node.id);
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function median(values, fallback = 0) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timingNodeId(timing, nodes) {
  if (timing?.stNodeId != null) return String(timing.stNodeId);
  return nodeId(nodes?.[Number(timing?.stNodeIndex)]);
}

function alignTimingAnchors(route) {
  const nodes = route?.stNodes ?? [];
  const timings = route?.stComboTimings ?? [];
  if (nodes.length < 2 || timings.length < 2) return null;
  const anchors = [];
  let searchFrom = 0;
  for (const timing of timings) {
    const id = timingNodeId(timing, nodes);
    if (!id) return null;
    const index = nodes.findIndex((node, candidateIndex) => (
      candidateIndex >= searchFrom && nodeId(node) === id
    ));
    if (index < 0) return null;
    anchors.push({ index, timing: clone(timing) });
    searchFrom = index + 1;
  }
  if (anchors[0].index !== 0 || anchors.at(-1).index !== nodes.length - 1) return null;
  return anchors;
}

function scaledPath(path, targetDistance, sourceDistance) {
  const result = clone(path ?? []);
  const pathDistance = result.reduce((total, segment) => total + Math.max(0, finite(segment?.length, 0)), 0);
  const denominator = pathDistance > 0 ? pathDistance : Math.max(0, finite(sourceDistance, 0));
  if (!(denominator > 0) || !(targetDistance >= 0)) return result;
  const scale = targetDistance / denominator;
  for (const segment of result) {
    if (Number.isFinite(Number(segment?.length))) segment.length = Math.max(0, Number(segment.length) * scale);
  }
  return result;
}

function repairCombos(route, anchors) {
  const nodes = route.stNodes ?? [];
  const sourceCombos = route.stCombos ?? [];
  const unused = new Set(sourceCombos.map((_, index) => index));
  const take = (start, end) => {
    for (const index of unused) {
      const combo = sourceCombos[index];
      if (String(combo?.startStNodeId) === start && String(combo?.endStNodeId) === end) {
        unused.delete(index);
        return clone(combo);
      }
    }
    return null;
  };
  const result = new Array(Math.max(0, nodes.length - 1));
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex++) {
    const left = anchors[anchorIndex].index;
    const right = anchors[anchorIndex + 1].index;
    const exact = [];
    let knownDistance = 0;
    for (let index = left; index < right; index++) {
      const combo = take(nodeId(nodes[index]), nodeId(nodes[index + 1]));
      exact[index] = combo;
      if (combo) knownDistance += Math.max(0, finite(combo.distance, 0));
    }
    let envelope = null;
    for (const index of unused) {
      const combo = sourceCombos[index];
      if (String(combo?.startStNodeId) === nodeId(nodes[left])
        && String(combo?.endStNodeId) === nodeId(nodes[right])) {
        envelope = clone(combo);
        unused.delete(index);
        break;
      }
    }
    const missingCount = exact.slice(left, right).filter((combo) => !combo).length;
    const envelopeDistance = Math.max(0, finite(envelope?.distance, 0));
    const residual = Math.max(0, envelopeDistance - knownDistance);
    const fallbackDistance = missingCount > 0
      ? (residual > 0 ? residual / missingCount : Math.max(envelopeDistance, knownDistance, 1) / (right - left))
      : 0;
    for (let index = left; index < right; index++) {
      if (exact[index]) {
        result[index] = exact[index];
        continue;
      }
      const distance = fallbackDistance;
      result[index] = {
        ...(envelope ? clone(envelope) : {}),
        startStNodeId: nodeId(nodes[index]),
        endStNodeId: nodeId(nodes[index + 1]),
        path: scaledPath(envelope?.path, distance, envelopeDistance),
        distance,
      };
    }
  }

  // A valid timing sequence anchors both ends, so this is normally empty.
  // Keep a fail-closed fallback for malformed legacy routes.
  for (let index = 0; index < result.length; index++) {
    result[index] ??= take(nodeId(nodes[index]), nodeId(nodes[index + 1])) ?? {
      startStNodeId: nodeId(nodes[index]),
      endStNodeId: nodeId(nodes[index + 1]),
      path: [],
      distance: 0,
    };
  }
  return result;
}

function repairTimings(route, anchors, combos) {
  const nodes = route.stNodes ?? [];
  const sourceTimings = route.stComboTimings ?? [];
  const dwellSeconds = median(sourceTimings.map((timing) => (
    finite(timing?.departureTime, 0) - finite(timing?.arrivalTime, 0)
  )), 0);
  const result = new Array(nodes.length);

  for (const anchor of anchors) {
    result[anchor.index] = {
      ...clone(anchor.timing),
      stNodeId: nodeId(nodes[anchor.index]),
      stNodeIndex: anchor.index,
    };
  }
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex++) {
    const left = anchors[anchorIndex].index;
    const right = anchors[anchorIndex + 1].index;
    const inserted = right - left - 1;
    if (inserted <= 0) continue;
    const startDeparture = finite(result[left]?.departureTime);
    const endArrival = finite(result[right]?.arrivalTime);
    if (startDeparture == null || endArrival == null || endArrival < startDeparture) return null;
    const weights = combos.slice(left, right).map((combo) => Math.max(0, finite(combo?.distance, 0)));
    let totalWeight = weights.reduce((total, weight) => total + weight, 0);
    if (!(totalWeight > 0)) {
      weights.fill(1);
      totalWeight = weights.length;
    }
    const movementSeconds = Math.max(0, endArrival - startDeparture - dwellSeconds * inserted);
    let time = startDeparture;
    for (let nodeIndex = left + 1; nodeIndex < right; nodeIndex++) {
      time += movementSeconds * (weights[nodeIndex - left - 1] / totalWeight);
      const arrivalTime = time;
      const departureTime = arrivalTime + dwellSeconds;
      result[nodeIndex] = {
        stNodeId: nodeId(nodes[nodeIndex]),
        stNodeIndex: nodeIndex,
        arrivalTime,
        departureTime,
      };
      time = departureTime;
    }
  }
  return result.every(Boolean) ? result : null;
}

/** Repair stop/combo/timing arrays after nodes are inserted into a clipped route. */
export function repairRouteTimingIntegrity(route) {
  const original = clone(route);
  const anchors = alignTimingAnchors(original);
  if (!anchors) return { route: original, changed: false, repairedStops: 0 };
  const combos = repairCombos(original, anchors);
  const timings = repairTimings(original, anchors, combos);
  if (!timings) return { route: original, changed: false, repairedStops: 0 };
  const repaired = { ...original, stCombos: combos, stComboTimings: timings };
  const changed = JSON.stringify([original.stCombos, original.stComboTimings])
    !== JSON.stringify([repaired.stCombos, repaired.stComboTimings]);
  return {
    route: repaired,
    changed,
    repairedStops: Math.max(0, timings.length - (original.stComboTimings?.length ?? 0)),
  };
}

function alignedTimingByNodeIndex(route) {
  const nodes = route?.stNodes ?? [];
  const result = new Map();
  let searchFrom = 0;
  for (const timing of route?.stComboTimings ?? []) {
    const id = timingNodeId(timing, nodes);
    if (!id) continue;
    const index = nodes.findIndex((node, candidateIndex) => (
      candidateIndex >= searchFrom && nodeId(node) === id
    ));
    if (index < 0) continue;
    result.set(index, clone(timing));
    searchFrom = index + 1;
  }
  return result;
}

function collapsedCombo(route, startIndex, endIndex) {
  const nodes = route?.stNodes ?? [];
  const combos = route?.stCombos ?? [];
  const chain = [];
  for (let index = startIndex; index < endIndex; index++) {
    const start = nodeId(nodes[index]);
    const end = nodeId(nodes[index + 1]);
    const combo = combos.find((candidate) => (
      String(candidate?.startStNodeId) === start
      && String(candidate?.endStNodeId) === end
    ));
    if (!combo) {
      return clone(combos.find((candidate) => (
        String(candidate?.startStNodeId) === nodeId(nodes[startIndex])
        && String(candidate?.endStNodeId) === nodeId(nodes[endIndex])
      )) ?? null);
    }
    chain.push(combo);
  }
  if (chain.length === 0) return null;
  const first = clone(chain[0]);
  return {
    ...first,
    startStNodeId: nodeId(nodes[startIndex]),
    endStNodeId: nodeId(nodes[endIndex]),
    path: chain.flatMap((combo) => clone(combo?.path ?? [])),
    distance: chain.reduce((total, combo) => total + Math.max(0, finite(combo?.distance, 0)), 0),
  };
}

/**
 * Remove station nodes without asking native route regeneration to search a
 * graph that is intentionally clipped. The route already contains the exact
 * directed path on both sides of each removed stop, so deletion is a splice:
 * concatenate those paths, retain anchored times, and rebuild strict
 * consecutive combo/timing arrays.
 */
export function removeRouteNodes(route, removedNodeIds) {
  const original = clone(route);
  const removed = new Set([...removedNodeIds].map(String));
  const indexedNodes = (original?.stNodes ?? [])
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => !removed.has(nodeId(node)));
  if (indexedNodes.length < 2 || indexedNodes.length === (original?.stNodes ?? []).length) {
    return { route: original, changed: false, removedStops: 0 };
  }

  const combos = [];
  for (let index = 0; index < indexedNodes.length - 1; index++) {
    const combo = collapsedCombo(original, indexedNodes[index].index, indexedNodes[index + 1].index);
    if (!combo) return { route: original, changed: false, removedStops: 0 };
    combos.push(combo);
  }

  const timingByIndex = alignedTimingByNodeIndex(original);
  let removedDwellSeconds = 0;
  const timings = indexedNodes.flatMap(({ node, index }, newIndex) => {
    for (let candidateIndex = indexedNodes[newIndex - 1]?.index + 1 || 0;
      candidateIndex < index;
      candidateIndex++) {
      if (!removed.has(nodeId(original.stNodes[candidateIndex]))) continue;
      const removedTiming = timingByIndex.get(candidateIndex);
      removedDwellSeconds += Math.max(
        0,
        finite(removedTiming?.departureTime, 0) - finite(removedTiming?.arrivalTime, 0),
      );
    }
    const timing = timingByIndex.get(index);
    return timing ? [{
      ...timing,
      stNodeId: nodeId(node),
      stNodeIndex: newIndex,
      ...(Number.isFinite(Number(timing.arrivalTime)) ? {
        arrivalTime: Number(timing.arrivalTime) - removedDwellSeconds,
      } : {}),
      ...(Number.isFinite(Number(timing.departureTime)) ? {
        departureTime: Number(timing.departureTime) - removedDwellSeconds,
      } : {}),
    }] : [];
  });
  const removedRoute = {
    ...original,
    stNodes: indexedNodes.map(({ node }) => clone(node)),
    stCombos: combos,
    stComboTimings: timings,
  };
  const repaired = repairRouteTimingIntegrity(removedRoute).route;
  return {
    route: repaired,
    changed: true,
    removedStops: (original.stNodes?.length ?? 0) - indexedNodes.length,
  };
}

/** Project canonical timings onto the route facade displayed in the current tile. */
export function projectRouteTimings(authoritativeRoute, visibleNodes) {
  const canonicalNodes = authoritativeRoute?.stNodes ?? [];
  const canonicalTimings = authoritativeRoute?.stComboTimings ?? [];
  if (!visibleNodes?.length || canonicalTimings.length !== canonicalNodes.length) return [];
  const selected = [];
  let searchFrom = 0;
  for (const node of visibleNodes) {
    const index = canonicalNodes.findIndex((candidate, candidateIndex) => (
      candidateIndex >= searchFrom && nodeId(candidate) === nodeId(node)
    ));
    if (index < 0) return [];
    selected.push(clone(canonicalTimings[index]));
    searchFrom = index + 1;
  }
  const offset = finite(selected[0]?.arrivalTime, 0);
  return selected.map((timing, index) => ({
    ...timing,
    stNodeId: nodeId(visibleNodes[index]),
    stNodeIndex: index,
    arrivalTime: finite(timing.arrivalTime, 0) - offset,
    departureTime: finite(timing.departureTime, 0) - offset,
  }));
}

export function repairNativeStateRouteTimings(nativeState) {
  let changed = false;
  let repairedRoutes = 0;
  let repairedStops = 0;
  const routes = (nativeState?.routes ?? []).map((route) => {
    const repair = repairRouteTimingIntegrity(route);
    if (!repair.changed) return clone(route);
    changed = true;
    repairedRoutes++;
    repairedStops += repair.repairedStops;
    return repair.route;
  });
  return {
    state: changed ? { ...clone(nativeState), routes } : nativeState,
    changed,
    repairedRoutes,
    repairedStops,
  };
}
