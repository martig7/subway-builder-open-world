export const NATIVE_DIRECTED_TRACK_SEARCH_VERSION = 'native-directed-track-search-v1.7.2';

// These are path selection costs, not track lengths. Match the inspected
// 1.7.2 persisted edge penalties, including its new crossover cost. This
// fallback does not implement the native bearing-based direction flip costs.
const PASS_THROUGH_PLATFORM_PENALTY = 10.1;
const TURNBACK_WRONG_WAY_PENALTY = 25;
const CROSSOVER_LANE_CHANGE_PENALTY = 2;

class TrackFrontier {
  items = [];
  sequence = 0;

  less(left, right) {
    return left.distance < right.distance
      || (left.distance === right.distance && left.sequence < right.sequence);
  }

  push(key, distance) {
    const entry = { key, distance, sequence: this.sequence++ };
    const items = this.items;
    items.push(entry);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(entry, items[parent])) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = entry;
  }

  pop() {
    const items = this.items;
    if (!items.length) return null;
    const first = items[0];
    const last = items.pop();
    if (items.length) {
      let index = 0;
      while (index * 2 + 1 < items.length) {
        const left = index * 2 + 1;
        const right = left + 1;
        const child = right < items.length && this.less(items[right], items[left]) ? right : left;
        if (!this.less(items[child], last)) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }
}

/** Search only the native directed graph; never invent a reverse edge. */
export function queryNativeDirectedTrackGraph(trackGraph, platformTrackIds, startKey, endKey, { withPath = false } = {}) {
  const distances = new Map([[startKey, 0]]);
  const previous = withPath ? new Map() : null;
  const frontier = new TrackFrontier();
  frontier.push(startKey, 0);
  let current;
  while ((current = frontier.pop())) {
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === endKey) {
      if (!withPath) return { distance: current.distance, path: null };
      const path = [];
      let cursor = endKey;
      while (cursor !== startKey) {
        const step = previous.get(cursor);
        if (!step) return { distance: Infinity, path: null };
        path.push({
          trackId: String(step.edge.trackId),
          reversed: Boolean(step.edge.trackIsReversed ?? step.edge.reversed),
          length: Number(step.edge.trackLength ?? step.edge.length) || 0,
          signals: [],
        });
        cursor = step.from;
      }
      return { distance: current.distance, path: path.reverse() };
    }
    for (const edge of trackGraph.get(current.key) ?? []) {
      const nextKey = String(edge?.coordsString ?? '');
      if (!nextKey) continue;
      const weight = 1
        + (platformTrackIds.has(String(edge?.trackId)) ? PASS_THROUGH_PLATFORM_PENALTY : 0)
        + ((edge?.trackIsReversed ?? edge?.reversed) ? TURNBACK_WRONG_WAY_PENALTY : 0)
        + (edge?.trackIsCrossover ? CROSSOVER_LANE_CHANGE_PENALTY : 0);
      const nextDistance = current.distance + weight;
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      previous?.set(nextKey, { from: current.key, edge });
      frontier.push(nextKey, nextDistance);
    }
  }
  return { distance: Infinity, path: null };
}
