// Experimental schedule-aware routing kernel. No runtime imports or libc.
// Double arithmetic and heap tie ordering intentionally match the JS router.
struct Label {
  double actual, cost;
  int station, state, route, boarded, parent, edge, source, driving;
};
struct HeapEntry { double cost; int state; int unused; };
static double maximum(double a, double b) { return a > b ? a : b; }
static double minimum(double a, double b) { return a < b ? a : b; }
static double infinity() { return __builtin_huge_val(); }

// Only the separate partition experiment enables these hooks. The ordinary
// Wasm build has identical priorities and does not read a lower-bound table.
#ifdef PARTITION_EXPERIMENT
static const double* partitionBounds = nullptr;
static int partitionMode = 0, partitionPruned = 0;
extern "C" void set_partition_bounds(const double* bounds, int mode) {
  partitionBounds = bounds; partitionMode = mode; partitionPruned = 0;
}
extern "C" int partition_pruned() { return partitionPruned; }
static double priority(double cost, int station) {
  return cost + (partitionMode == 2 ? partitionBounds[station] : 0);
}
#define SEARCH_PRIORITY(cost, station) priority(cost, station)
#else
#define SEARCH_PRIORITY(cost, station) cost
#endif

static void push(HeapEntry* heap, int& size, HeapEntry entry) {
  int at = size++;
  while (at > 0) {
    int parent = (at - 1) / 2;
    if (heap[parent].cost <= entry.cost) break;
    heap[at] = heap[parent]; at = parent;
  }
  heap[at] = entry;
}
static HeapEntry pop(HeapEntry* heap, int& size) {
  HeapEntry root = heap[0], tail = heap[--size];
  if (size > 0) {
    int at = 0;
    while (true) {
      int left = at * 2 + 1, right = left + 1;
      if (left >= size) break;
      int child = right < size && heap[right].cost < heap[left].cost ? right : left;
      if (heap[child].cost >= tail.cost) break;
      heap[at] = heap[child]; at = child;
    }
    heap[at] = tail;
  }
  return root;
}

static double departure(const double* edge, const double* periods, const double* phases, double ready) {
  double headway = edge[6] > 0 && edge[7] > 0 ? edge[6] / edge[7] : 0;
  int periodCount = (int)edge[9];
  if (periodCount >= 0) {
    // Equivalent to positive modulo for finite simulation timestamps.
    double hour = (ready - __builtin_floor(ready / 86400.0) * 86400.0) / 3600.0;
    headway = 0;
    for (int i = 0; i < periodCount; ++i) {
      const double* period = periods + ((int)edge[8] + i) * 3;
      bool includes = period[0] <= period[1] ? hour >= period[0] && hour < period[1] : hour >= period[0] || hour < period[1];
      if (includes) { headway = period[2]; break; }
    }
  }
  if (!(headway > 0)) return infinity();
  if (edge[11] > 0 && edge[6] > 0) {
    double next = infinity();
    for (int i = 0; i < (int)edge[11]; ++i) {
      double phase = phases[(int)edge[10] + i];
      double cycles = maximum(0, __builtin_ceil((ready - phase) / edge[6]));
      next = minimum(next, phase + cycles * edge[6]);
    }
    return next;
  }
  double cycles = maximum(0, __builtin_ceil((ready - edge[5]) / headway));
  return edge[5] + cycles * headway;
}

extern "C" int label_size() { return sizeof(Label); }
extern "C" int heap_entry_size() { return sizeof(HeapEntry); }

// Edge layout: destination, state, route-state (0 = walk), seconds, dwell,
// offset, cycle, service-count, period-offset/count, departure-phase-offset/count.
// Result: status (-1 = capacity fallback), source-index, egress, edge-count,
// relaxed-edges, settled-states, created-labels, contracted-edges.
extern "C" int search(int states, int capacity, const int* offsets, const double* edges,
  const int* chainOffsets, const int* chains, const double* periods, const double* phases,
  const double* starts, int startCount, const double* ends,
  double requested, double walkWeight, double waitWeight, double shiftWeight, double gap, double bound,
  Label* labels, int* bestLabel, HeapEntry* heap, int* path, double* result) {
  for (int i = 0; i < states; ++i) bestLabel[i] = -1;
  for (int i = 0; i < 8; ++i) result[i] = 0;
  int count = 0, heapSize = 0, winner = -1;
  double best = bound, egress = 0;
  for (int i = 0; i < startCount; ++i) {
    int station = (int)starts[i * 3], driving = (int)starts[i * 3 + 2];
    double seconds = starts[i * 3 + 1], cost = seconds * (driving ? 1 : walkWeight);
    if (bestLabel[station] >= 0 && cost >= labels[bestLabel[station]].cost) continue;
    if (count >= capacity) { result[0] = -1; return -1; }
    labels[count] = {requested + seconds, cost, station, station, 0, 0, -1, -1, i, driving};
    bestLabel[station] = count++;
    push(heap, heapSize, {SEARCH_PRIORITY(cost, station), station, 0});
  }
  while (heapSize > 0 && heap[0].cost < best) {
    HeapEntry current = pop(heap, heapSize);
    int currentIndex = bestLabel[current.state];
    if (currentIndex < 0 || current.cost != SEARCH_PRIORITY(labels[currentIndex].cost, labels[currentIndex].station)) continue;
    const Label currentLabel = labels[currentIndex];
#ifdef PARTITION_EXPERIMENT
    if (partitionMode && currentLabel.cost + partitionBounds[currentLabel.station] > best) {
      partitionPruned++; continue;
    }
#endif
    result[5] += 1;
    if (ends[currentLabel.station] != infinity() && (currentLabel.boarded || !currentLabel.driving)) {
      double candidate = currentLabel.cost + ends[currentLabel.station] * walkWeight;
      if (candidate < best) { best = candidate; egress = ends[currentLabel.station]; winner = currentIndex; }
    }
    for (int first = offsets[currentLabel.station]; first < offsets[currentLabel.station + 1]; ++first) {
      int previousIndex = currentIndex;
      for (int ci = chainOffsets[first]; ci < chainOffsets[first + 1]; ++ci) {
        int edgeId = chains[ci];
        const double* edge = edges + edgeId * 12;
        const Label& previous = labels[previousIndex];
        int station = (int)edge[0], state = (int)edge[1], route = (int)edge[2];
        double actual, cost;
        int boarded = previous.boarded;
        result[4] += 1;
        if (!route) {
          actual = previous.actual + edge[3];
          cost = previous.cost + edge[3] * walkWeight;
        } else {
          double leave, shift, wait, vehicle;
          if (previous.route == route) {
            leave = previous.actual + edge[4]; shift = 0; wait = 0; vehicle = edge[4] + edge[3];
          } else {
            double arrivalGap = previous.boarded ? 0 : gap;
            leave = departure(edge, periods, phases, previous.actual + arrivalGap);
            if (leave == infinity()) break;
            shift = previous.boarded ? 0 : maximum(0, leave - arrivalGap - previous.actual);
            wait = previous.boarded ? maximum(0, leave - previous.actual) : arrivalGap;
            vehicle = edge[3];
          }
          actual = leave + edge[3];
          cost = previous.cost + shift * shiftWeight + wait * waitWeight + vehicle;
          boarded = 1;
        }
        if (bestLabel[state] >= 0 && cost >= labels[bestLabel[state]].cost) break;
        if (count >= capacity) { result[0] = -1; return -1; }
        labels[count] = {actual, cost, station, state, route, boarded, previousIndex, edgeId, previous.source, previous.driving};
        bestLabel[state] = count++;
        if (ci == chainOffsets[first + 1] - 1 || ends[station] != infinity()) {
          push(heap, heapSize, {SEARCH_PRIORITY(cost, station), state, 0}); break;
        }
        result[7] += 1;
        previousIndex = count - 1;
      }
    }
  }
  result[6] = count;
  if (winner < 0) return 0;
  result[0] = 1; result[1] = labels[winner].source; result[2] = egress;
  int length = 0;
  for (int index = winner; labels[index].parent >= 0; index = labels[index].parent) path[length++] = labels[index].edge;
  result[3] = length;
  return 1;
}
