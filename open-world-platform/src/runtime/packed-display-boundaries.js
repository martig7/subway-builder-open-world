export function decodePackedBoundaryGeometry(packed, scale) {
  const polygons = JSON.parse(packed.packedCoordinates).map(polygon => polygon.map(deltas => {
    let x = 0, y = 0;
    const ring = [];
    for (let i = 0; i < deltas.length; i += 2) {
      x += deltas[i]; y += deltas[i + 1];
      ring.push([x / scale, y / scale]);
    }
    return ring;
  }));
  return { type: packed.type, coordinates: packed.type === 'Polygon' || packed.type === 'MultiLineString' ? polygons[0]
    : packed.type === 'LineString' ? polygons[0][0] : polygons };
}

export function createPackedBoundaryLookup(overlay) {
  if (!['quantized-display-boundaries-v1', 'inland-display-boundaries-v2'].includes(overlay?.encoding)) return null;
  const levels = overlay.lods.map(level => new Map(level.features.map(feature => [
    String(feature.properties?.pref_code ?? feature.properties?.prefCode ?? feature.properties?.id),
    feature.geometry,
  ])));
  // Exactly one decoded level per owner; zooming does not accumulate all LODs.
  const current = new Map();
  return {
    has: (key, level) => levels[level].has(key),
    geometry(key, level) {
      const cached = current.get(key);
      if (cached?.level === level) return cached.geometry;
      const packed = levels[level].get(key);
      if (!packed) return null;
      const geometry = decodePackedBoundaryGeometry(packed, overlay.scale);
      current.set(key, { level, geometry });
      return geometry;
    },
  };
}
