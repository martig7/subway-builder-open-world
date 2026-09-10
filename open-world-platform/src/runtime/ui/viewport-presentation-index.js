const DEFAULT_CELL_SIZE = 0.25;
const DEFAULT_PADDING_RATIO = 0.5;
const MAX_GRID_CELLS_PER_FEATURE = 256;
const MAX_GRID_REFERENCES = 100_000;

function finiteNumber(value) {
  if (value == null || typeof value === 'boolean' || Array.isArray(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function wrapLongitude(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

function readBounds(value) {
  if (Array.isArray(value) && value.length >= 4) {
    return value.slice(0, 4).map(finiteNumber);
  }
  if (value && typeof value === 'object') {
    if (['getWest', 'getSouth', 'getEast', 'getNorth'].every((key) => typeof value[key] === 'function')) {
      return [value.getWest(), value.getSouth(), value.getEast(), value.getNorth()].map(finiteNumber);
    }
    if (value._sw && value._ne) {
      return [value._sw.lng, value._sw.lat, value._ne.lng, value._ne.lat].map(finiteNumber);
    }
    if (value.sw && value.ne) {
      return [value.sw.lng, value.sw.lat, value.ne.lng, value.ne.lat].map(finiteNumber);
    }
  }
  return null;
}

function longitudeSpan(west, east) {
  const start = wrapLongitude(west);
  let span = east - west;
  if (west > east || span < 0) span = ((east - west) % 360 + 360) % 360;
  if (span >= 360) return { start: -180, span: 360 };
  return { start, span };
}

function splitLongitudeArc(start, span, south, north) {
  if (span >= 360) return [[-180, south, 180, north]];
  const west = wrapLongitude(start);
  const unwrappedEast = west + span;
  if (unwrappedEast <= 180) return [[west, south, unwrappedEast, north]];
  return [[west, south, 180, north], [-180, south, unwrappedEast - 360, north]];
}

function normalizeBounds(value) {
  const raw = readBounds(value);
  if (!raw || raw.some((entry) => entry == null)) return null;
  const [west, rawSouth, east, rawNorth] = raw;
  const south = Math.max(-90, Math.min(rawSouth, rawNorth));
  const north = Math.min(90, Math.max(rawSouth, rawNorth));
  const arc = longitudeSpan(west, east);
  return { ...arc, south, north, boxes: splitLongitudeArc(arc.start, arc.span, south, north) };
}

function paddedBounds(bounds, paddingRatio) {
  const ratio = Math.max(0, finiteNumber(paddingRatio) ?? DEFAULT_PADDING_RATIO);
  const longitudePadding = Math.min(180, bounds.span * ratio);
  const latitudePadding = (bounds.north - bounds.south) * ratio;
  const span = Math.min(360, bounds.span + longitudePadding * 2);
  const start = span >= 360 ? -180 : bounds.start - longitudePadding;
  const south = Math.max(-90, bounds.south - latitudePadding);
  const north = Math.min(90, bounds.north + latitudePadding);
  return { start, span, south, north, boxes: splitLongitudeArc(start, span, south, north) };
}

function boxIntersects(left, right) {
  return left[0] <= right[2] && left[2] >= right[0]
    && left[1] <= right[3] && left[3] >= right[1];
}

function boxContains(outer, inner) {
  return outer[0] <= inner[0] && outer[2] >= inner[2]
    && outer[1] <= inner[1] && outer[3] >= inner[3];
}

function boxesContain(outers, inners) {
  return inners.every((inner) => outers.some((outer) => boxContains(outer, inner)));
}

function circleIntersectsBox(region, box) {
  const scaleX = finiteNumber(region?.scale?.[0]);
  const scaleY = finiteNumber(region?.scale?.[1]);
  const centerX = finiteNumber(region?.center?.[0]);
  const centerY = finiteNumber(region?.center?.[1]);
  const distance = finiteNumber(region?.distance);
  if ([scaleX, scaleY, centerX, centerY, distance].some((value) => value == null)) return true;
  for (const shift of [-360, 0, 360]) {
    const shiftedCenter = centerX + shift;
    const x = Math.max(box[0], Math.min(shiftedCenter, box[2]));
    const y = Math.max(box[1], Math.min(centerY, box[3]));
    if (Math.hypot((x - shiftedCenter) * scaleX, (y - centerY) * scaleY) <= distance + 1e-9) return true;
  }
  return false;
}

function haloParts(haloBounds) {
  if (!Array.isArray(haloBounds) || !haloBounds.length) return [];
  return haloBounds.flatMap((value) => {
    const normalized = normalizeBounds(value);
    if (!normalized) return [];
    return normalized.boxes.map((box) => ({ box, region: value?.region ?? null }));
  });
}

function intersectsHalo(boxes, parts) {
  if (!parts.length) return true;
  return boxes.some((box) => parts.some((part) => boxIntersects(box, part.box)
    && (part.region?.shape !== 'circle' || circleIntersectsBox(part.region, box))));
}

function coordinateBounds(feature) {
  const longitudes = [];
  let south = Infinity;
  let north = -Infinity;
  const visitCoordinates = (value) => {
    if (!Array.isArray(value)) return;
    const longitude = finiteNumber(value[0]);
    const latitude = finiteNumber(value[1]);
    if (longitude != null && latitude != null) {
      longitudes.push(wrapLongitude(longitude));
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
      return;
    }
    for (const child of value) visitCoordinates(child);
  };
  const visitGeometry = (geometry) => {
    if (!geometry || typeof geometry !== 'object') return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries ?? []) visitGeometry(child);
    } else visitCoordinates(geometry.coordinates);
  };
  const geometry = feature?.type === 'Feature' ? feature.geometry : feature?.geometry ?? feature;
  visitGeometry(geometry);
  if (!longitudes.length || !Number.isFinite(south) || !Number.isFinite(north)) return null;
  const sorted = [...new Set(longitudes)].sort((left, right) => left - right);
  if (sorted.length === 1) return [[sorted[0], south, sorted[0], north]];
  let gapIndex = 0;
  let largestGap = -Infinity;
  for (let index = 0; index < sorted.length; index += 1) {
    const next = index + 1 < sorted.length ? sorted[index + 1] : sorted[0] + 360;
    const gap = next - sorted[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const start = sorted[(gapIndex + 1) % sorted.length];
  const span = 360 - largestGap;
  return splitLongitudeArc(start, span, Math.max(-90, south), Math.min(90, north));
}

function haloSignature(parts) {
  return parts.map(({ box, region }) => [
    ...box,
    region?.shape ?? '',
    ...(region?.center ?? []),
    ...(region?.scale ?? []),
    region?.distance ?? '',
  ].join(',')).join('|');
}

/**
 * Builds a revision-keyed spatial index for renderer presentation only.
 * Canonical world and simulation collections are never mutated or filtered.
 */
export function createViewportPresentationIndex({
  cellSize = DEFAULT_CELL_SIZE,
  paddingRatio = DEFAULT_PADDING_RATIO,
  maxCellsPerFeature = MAX_GRID_CELLS_PER_FEATURE,
  maxGridReferences = MAX_GRID_REFERENCES,
} = {}) {
  const size = Math.max(1e-6, finiteNumber(cellSize) ?? DEFAULT_CELL_SIZE);
  const cellLimit = Math.max(1, Math.floor(finiteNumber(maxCellsPerFeature) ?? MAX_GRID_CELLS_PER_FEATURE));
  const referenceLimit = Math.max(1, Math.floor(finiteNumber(maxGridReferences) ?? MAX_GRID_REFERENCES));
  let source = [];
  let revision = null;
  let hasRevision = false;
  let invalidated = true;
  let featureBoxes = [];
  let broadIndices = [];
  let grid = new Map();
  let gridReferences = 0;
  let marks = new Uint32Array(0);
  let markGeneration = 0;
  let buildGeneration = 0;
  let queryGeneration = 0;
  let cachedQuery = null;

  const keyFor = (x, y) => `${x}:${y}`;

  const rebuild = (features, nextRevision, nextHasRevision) => {
    source = features;
    revision = nextRevision;
    hasRevision = nextHasRevision;
    invalidated = false;
    featureBoxes = new Array(features.length);
    broadIndices = [];
    grid = new Map();
    gridReferences = 0;
    marks = new Uint32Array(features.length);
    markGeneration = 0;
    cachedQuery = null;
    buildGeneration += 1;
    for (let index = 0; index < features.length; index += 1) {
      const boxes = coordinateBounds(features[index]);
      featureBoxes[index] = boxes;
      if (!boxes) {
        broadIndices.push(index);
        continue;
      }
      let cells = 0;
      for (const box of boxes) {
        const west = Math.floor((box[0] + 180) / size);
        const east = Math.floor((box[2] + 180) / size);
        const south = Math.floor((box[1] + 90) / size);
        const north = Math.floor((box[3] + 90) / size);
        cells += (east - west + 1) * (north - south + 1);
      }
      if (cells > cellLimit || cells > referenceLimit - gridReferences) {
        broadIndices.push(index);
        continue;
      }
      for (const box of boxes) {
        const west = Math.floor((box[0] + 180) / size);
        const east = Math.floor((box[2] + 180) / size);
        const south = Math.floor((box[1] + 90) / size);
        const north = Math.floor((box[3] + 90) / size);
        for (let y = south; y <= north; y += 1) {
          for (let x = west; x <= east; x += 1) {
            const key = keyFor(x, y);
            const bucket = grid.get(key);
            if (bucket) bucket.push(index);
            else grid.set(key, [index]);
            gridReferences += 1;
          }
        }
      }
    }
  };

  return {
    get source() { return source; },
    get revision() { return revision; },
    invalidate() {
      invalidated = true;
      cachedQuery = null;
    },
    update(input, { revision: nextRevision = null } = {}) {
      const features = Array.isArray(input) ? input : input?.features;
      if (!Array.isArray(features)) return false;
      const nextHasRevision = nextRevision != null;
      const unchanged = !invalidated
        && nextHasRevision === hasRevision
        && (nextHasRevision
          ? Object.is(nextRevision, revision)
          : features === source && features.length === source.length);
      if (unchanged) return false;
      rebuild(features, nextRevision, nextHasRevision);
      return true;
    },
    query({
      viewportBounds,
      haloBounds = [],
      paddingRatio: queryPadding = paddingRatio,
      refit = false,
    } = {}) {
      const viewport = normalizeBounds(viewportBounds);
      if (!viewport) {
        return {
          features: source,
          indices: source.map((_, index) => index),
          signature: `viewport-unknown:${buildGeneration}`,
          presentationBounds: [],
          stats: {
            visitedCandidates: source.length,
            totalFeatures: source.length,
            gridReferences,
            broadFeatures: broadIndices.length,
            reused: false,
          },
        };
      }
      const parts = haloParts(haloBounds);
      const nextHaloSignature = haloSignature(parts);
      const viewportHeight = viewport.north - viewport.south;
      const substantiallyZoomedIn = cachedQuery
        && viewport.span < cachedQuery.viewportSpan * 0.5
        && viewportHeight < cachedQuery.viewportHeight * 0.5;
      if (cachedQuery
        && !refit
        && !substantiallyZoomedIn
        && cachedQuery.haloSignature === nextHaloSignature
        && boxesContain(cachedQuery.presentationBounds, viewport.boxes)) {
        cachedQuery.result.stats = { ...cachedQuery.result.stats, reused: true };
        return cachedQuery.result;
      }
      const presentation = paddedBounds(viewport, queryPadding);
      const collected = [];
      let visitedCandidates = 0;
      markGeneration = markGeneration === 0xffffffff ? 1 : markGeneration + 1;
      if (markGeneration === 1) marks.fill(0);
      const consider = (index) => {
        if (marks[index] === markGeneration) return;
        marks[index] = markGeneration;
        visitedCandidates += 1;
        const boxes = featureBoxes[index];
        if (!boxes || (boxes.some((box) => presentation.boxes.some((region) => boxIntersects(box, region)))
          && intersectsHalo(boxes, parts))) collected.push(index);
      };
      for (const index of broadIndices) consider(index);
      const queryCells = presentation.boxes.reduce((total, box) => {
        const west = Math.floor((box[0] + 180) / size);
        const east = Math.floor((box[2] + 180) / size);
        const south = Math.floor((box[1] + 90) / size);
        const north = Math.floor((box[3] + 90) / size);
        return total + (east - west + 1) * (north - south + 1);
      }, 0);
      // At overview zooms a degree grid can cover millions of empty cells.
      // Walk populated cells in that case; either path is paid only when the
      // camera leaves the stable padded region.
      if (queryCells > Math.max(64, grid.size * 2)) {
        for (const [key, bucket] of grid) {
          const separator = key.indexOf(':');
          const x = Number(key.slice(0, separator));
          const y = Number(key.slice(separator + 1));
          const cell = [x * size - 180, y * size - 90, (x + 1) * size - 180, (y + 1) * size - 90];
          if (presentation.boxes.some((box) => boxIntersects(cell, box))) {
            for (const index of bucket) consider(index);
          }
        }
      } else {
        for (const box of presentation.boxes) {
          const west = Math.floor((box[0] + 180) / size);
          const east = Math.floor((box[2] + 180) / size);
          const south = Math.floor((box[1] + 90) / size);
          const north = Math.floor((box[3] + 90) / size);
          for (let y = south; y <= north; y += 1) {
            for (let x = west; x <= east; x += 1) {
              for (const index of grid.get(keyFor(x, y)) ?? []) consider(index);
            }
          }
        }
      }
      collected.sort((left, right) => left - right);
      const selectionReused = cachedQuery
        && collected.length === cachedQuery.result.indices.length
        && collected.every((index, position) => index === cachedQuery.result.indices[position]);
      if (!selectionReused) queryGeneration += 1;
      const result = {
        features: selectionReused
          ? cachedQuery.result.features
          : collected.map((index) => source[index]),
        indices: selectionReused ? cachedQuery.result.indices : collected,
        signature: selectionReused
          ? cachedQuery.result.signature
          : `viewport-presentation:${buildGeneration}:${queryGeneration}`,
        presentationBounds: presentation.boxes,
        stats: {
          visitedCandidates,
          totalFeatures: source.length,
          gridReferences,
          broadFeatures: broadIndices.length,
          reused: false,
          selectionReused: Boolean(selectionReused),
        },
      };
      cachedQuery = {
        haloSignature: nextHaloSignature,
        presentationBounds: presentation.boxes,
        viewportSpan: viewport.span,
        viewportHeight,
        result,
      };
      return result;
    },
  };
}

/**
 * Partitions GeoJSON into stable, bounded data arrays suitable for persistent
 * Deck sublayers. Camera motion selects whole chunks; it never reconstructs a
 * monolithic FeatureCollection or edits canonical feature objects.
 */
export function createStableGeoJsonChunks({
  cellSize = DEFAULT_CELL_SIZE,
  paddingRatio = DEFAULT_PADDING_RATIO,
  maxFeaturesPerChunk = 128,
  maxCellsPerFeature = MAX_GRID_CELLS_PER_FEATURE,
  maxGridReferences = MAX_GRID_REFERENCES,
} = {}) {
  const size = Math.max(1e-6, finiteNumber(cellSize) ?? DEFAULT_CELL_SIZE);
  const featureLimit = Math.max(1, Math.floor(finiteNumber(maxFeaturesPerChunk) ?? 128));
  const cellLimit = Math.max(1, Math.floor(finiteNumber(maxCellsPerFeature) ?? MAX_GRID_CELLS_PER_FEATURE));
  const referenceLimit = Math.max(1, Math.floor(finiteNumber(maxGridReferences) ?? MAX_GRID_REFERENCES));
  let source = [];
  let revision = null;
  let hasRevision = false;
  let invalidated = true;
  let chunks = [];
  let chunkOrder = new Map();
  let chunkGrid = new Map();
  let broadChunks = [];
  let gridReferences = 0;
  let buildGeneration = 0;
  let selectionGeneration = 0;
  let cachedQuery = null;

  const cellRange = (box) => ({
    west: Math.floor((box[0] + 180) / size),
    east: Math.floor((box[2] + 180) / size),
    south: Math.floor((box[1] + 90) / size),
    north: Math.floor((box[3] + 90) / size),
  });
  const cellsForBoxes = (boxes) => boxes.reduce((total, box) => {
    const range = cellRange(box);
    return total + (range.east - range.west + 1) * (range.north - range.south + 1);
  }, 0);
  const chunkIntersects = (chunk, presentationBoxes, parts) => chunk.bounds == null
    || (chunk.bounds.some((box) => presentationBoxes.some((region) => boxIntersects(box, region)))
      && intersectsHalo(chunk.bounds, parts));

  const rebuild = (features, nextRevision, nextHasRevision) => {
    source = features;
    revision = nextRevision;
    hasRevision = nextHasRevision;
    invalidated = false;
    cachedQuery = null;
    buildGeneration += 1;
    const groups = new Map();
    const groupOrder = [];
    for (let index = 0; index < features.length; index += 1) {
      const boxes = coordinateBounds(features[index]);
      let key = 'broad';
      if (boxes && cellsForBoxes(boxes) <= cellLimit) {
        const anchor = boxes[0];
        const x = Math.floor((((anchor[0] + anchor[2]) / 2) + 180) / size);
        const y = Math.floor((((anchor[1] + anchor[3]) / 2) + 90) / size);
        key = `cell:${x}:${y}`;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
        groupOrder.push(key);
      }
      groups.get(key).push({ feature: features[index], boxes, sourceIndex: index });
    }

    chunks = [];
    for (const key of groupOrder) {
      const entries = groups.get(key);
      for (let offset = 0, part = 0; offset < entries.length; offset += featureLimit, part += 1) {
        const slice = entries.slice(offset, offset + featureLimit);
        const bounds = slice.some((entry) => entry.boxes == null)
          ? null
          : slice.flatMap((entry) => entry.boxes.map((box) => Object.freeze([...box])));
        chunks.push(Object.freeze({
          id: `geo-${key}:${part}`,
          features: Object.freeze(slice.map((entry) => entry.feature)),
          bounds: bounds == null ? null : Object.freeze(bounds),
          sourceIndices: Object.freeze(slice.map((entry) => entry.sourceIndex)),
        }));
      }
    }

    chunkGrid = new Map();
    broadChunks = [];
    gridReferences = 0;
    chunkOrder = new Map(chunks.map((chunk, index) => [chunk, index]));
    for (const chunk of chunks) {
      if (chunk.bounds == null) {
        broadChunks.push(chunk);
        continue;
      }
      const keys = new Set();
      for (const box of chunk.bounds) {
        const range = cellRange(box);
        for (let y = range.south; y <= range.north && keys.size <= cellLimit; y += 1) {
          for (let x = range.west; x <= range.east && keys.size <= cellLimit; x += 1) {
            keys.add(`${x}:${y}`);
          }
        }
      }
      if (keys.size > cellLimit || keys.size > referenceLimit - gridReferences) {
        broadChunks.push(chunk);
        continue;
      }
      for (const key of keys) {
        const bucket = chunkGrid.get(key);
        if (bucket) bucket.push(chunk);
        else chunkGrid.set(key, [chunk]);
        gridReferences += 1;
      }
    }
  };

  return {
    get chunks() { return chunks; },
    get source() { return source; },
    get revision() { return revision; },
    invalidate() {
      invalidated = true;
      cachedQuery = null;
    },
    update(input, { revision: nextRevision = null } = {}) {
      const features = Array.isArray(input) ? input : input?.features;
      if (!Array.isArray(features)) return false;
      const nextHasRevision = nextRevision != null;
      const unchanged = !invalidated
        && nextHasRevision === hasRevision
        && (nextHasRevision ? Object.is(nextRevision, revision) : features === source);
      if (unchanged) return false;
      rebuild(features, nextRevision, nextHasRevision);
      return true;
    },
    query({ viewportBounds, haloBounds = [], paddingRatio: queryPadding = paddingRatio, refit = false } = {}) {
      const viewport = normalizeBounds(viewportBounds);
      if (!viewport) {
        return {
          chunks,
          signature: `geo-chunks:${buildGeneration}:all`,
          stats: {
            totalFeatures: source.length, totalChunks: chunks.length,
            visitedChunks: chunks.length, gridReferences, broadChunks: broadChunks.length,
          },
        };
      }
      const presentation = paddedBounds(viewport, queryPadding);
      const parts = haloParts(haloBounds);
      const nextHaloSignature = haloSignature(parts);
      if (cachedQuery
        && !refit
        && cachedQuery.haloSignature === nextHaloSignature
        && boxesContain(cachedQuery.presentationBounds, viewport.boxes)) return cachedQuery.result;

      const candidates = new Set(broadChunks);
      const queryCells = presentation.boxes.reduce((total, box) => total + cellsForBoxes([box]), 0);
      if (queryCells > Math.max(64, chunkGrid.size * 2)) {
        for (const [key, bucket] of chunkGrid) {
          const separator = key.indexOf(':');
          const x = Number(key.slice(0, separator));
          const y = Number(key.slice(separator + 1));
          const cell = [x * size - 180, y * size - 90, (x + 1) * size - 180, (y + 1) * size - 90];
          if (presentation.boxes.some((box) => boxIntersects(cell, box))) {
            for (const chunk of bucket) candidates.add(chunk);
          }
        }
      } else {
        for (const box of presentation.boxes) {
          const range = cellRange(box);
          for (let y = range.south; y <= range.north; y += 1) {
            for (let x = range.west; x <= range.east; x += 1) {
              for (const chunk of chunkGrid.get(`${x}:${y}`) ?? []) candidates.add(chunk);
            }
          }
        }
      }
      const selected = [...candidates]
        .filter((chunk) => chunkIntersects(chunk, presentation.boxes, parts))
        .sort((left, right) => chunkOrder.get(left) - chunkOrder.get(right));
      const selectionReused = cachedQuery
        && selected.length === cachedQuery.result.chunks.length
        && selected.every((chunk, index) => chunk === cachedQuery.result.chunks[index]);
      if (!selectionReused) selectionGeneration += 1;
      const result = {
        chunks: selectionReused ? cachedQuery.result.chunks : selected,
        signature: selectionReused
          ? cachedQuery.result.signature
          : `geo-chunks:${buildGeneration}:${selectionGeneration}`,
        presentationBounds: presentation.boxes,
        stats: {
          totalFeatures: source.length,
          totalChunks: chunks.length,
          visitedChunks: candidates.size,
          gridReferences,
          broadChunks: broadChunks.length,
          selectionReused: Boolean(selectionReused),
        },
      };
      cachedQuery = { haloSignature: nextHaloSignature, presentationBounds: presentation.boxes, result };
      return result;
    },
  };
}
