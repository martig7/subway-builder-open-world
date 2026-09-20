// Experiment only. Reuse applies within ONE synchronous evaluator job whose
// network and fare inputs are immutable plain-data snapshots. Never attach this
// scope to a long-lived game store or retain it across worker requests.
function graphEntries(networkProfiles) {
  return Object.entries(networkProfiles ?? {}).filter(([, profile]) => profile)
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Retains only the last graph input/key and the last compiled fare index. */
export function createEvaluationMemo() {
  let previousGraph = null, previousFares = null;
  const stats = {
    graphCalls: 0, graphHits: 0, graphSerializations: 0,
    fareCalls: 0, fareHits: 0, fareBuilds: 0,
    retainedGraphSnapshots: 0, retainedFareIndexes: 0,
    graphKeyBytes: 0, fareEntries: 0, peakGraphKeyBytes: 0, peakFareEntries: 0,
  };
  return {
    stats,
    graphKey(networkProfiles) {
      stats.graphCalls++;
      const entries = graphEntries(networkProfiles);
      if (previousGraph && previousGraph.entries.length === entries.length
        && entries.every(([tile, profile], index) => tile === previousGraph.entries[index][0]
          && profile === previousGraph.entries[index][1])) {
        stats.graphHits++;
        return previousGraph.key;
      }
      const key = JSON.stringify(entries);
      previousGraph = { entries, key };
      stats.graphSerializations++;
      stats.retainedGraphSnapshots = 1;
      // UTF-16 upper estimate; this key is shared with getRouter's existing key.
      stats.graphKeyBytes = key.length * 2;
      stats.peakGraphKeyBytes = Math.max(stats.peakGraphKeyBytes, stats.graphKeyBytes);
      return key;
    },
    fareIndex(fareGroups, routes, legacyFare, buildIndex) {
      stats.fareCalls++;
      if (previousFares && previousFares.fareGroups === fareGroups
        && previousFares.routes === routes && Object.is(previousFares.legacyFare, legacyFare)
        && previousFares.buildIndex === buildIndex) {
        stats.fareHits++;
        return previousFares.index;
      }
      const index = buildIndex(fareGroups, routes, legacyFare);
      previousFares = { fareGroups, routes, legacyFare, buildIndex, index };
      stats.fareBuilds++;
      stats.retainedFareIndexes = 1;
      stats.fareEntries = index.size;
      stats.peakFareEntries = Math.max(stats.peakFareEntries, stats.fareEntries);
      return index;
    },
    clear() {
      previousGraph = null; previousFares = null;
      stats.retainedGraphSnapshots = 0; stats.retainedFareIndexes = 0;
      stats.graphKeyBytes = 0; stats.fareEntries = 0;
    },
  };
}

let activeMemo = null;

/**
 * The synchronous call establishes the lifetime; finally always releases refs.
 * Accessors recompute normally outside this scope. Use a fresh scope per job,
 * including when a previously used object has been mutated between jobs.
 */
export function withEvaluationMemo(evaluate) {
  if (typeof evaluate !== 'function') throw new TypeError('evaluate must be a synchronous function');
  const memo = createEvaluationMemo(), previous = activeMemo;
  activeMemo = memo;
  try {
    const result = evaluate(memo);
    if (result && typeof result.then === 'function') throw new TypeError('withEvaluationMemo requires synchronous evaluation');
    return result;
  } finally {
    memo.clear(); activeMemo = previous;
  }
}

export function evaluationGraphKey(networkProfiles) {
  return activeMemo ? activeMemo.graphKey(networkProfiles) : JSON.stringify(graphEntries(networkProfiles));
}

export function evaluationFareIndex(fareGroups, routes, legacyFare, buildIndex) {
  return activeMemo ? activeMemo.fareIndex(fareGroups, routes, legacyFare, buildIndex)
    : buildIndex(fareGroups, routes, legacyFare);
}
