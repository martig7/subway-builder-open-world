// Packaging only: ownership/computation files never enter this transformation.
// Reuse the producer's shared-edge simplification instead of independently
// simplifying adjacent polygons and opening seams between owners.
export function packDisplayBoundaryOverlay(overlay) {
  if (overlay?.purpose !== 'display-only' || !overlay.lods?.length
    || overlay.quantizationDegrees !== 0.00001) return overlay;
  const levels = overlay.lods.filter(level => level.toleranceMetres >= 25);
  if (!levels.length) return overlay;
  const scale = 100000;
  const packGeometry = geometry => {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
      : geometry.type === 'LineString' ? [[geometry.coordinates]]
      : geometry.type === 'MultiLineString' ? [geometry.coordinates] : geometry.coordinates;
    const coordinates = polygons.map(polygon => polygon.map(ring => {
      let x = 0, y = 0;
      const deltas = [];
      for (const point of ring) {
        const nextX = Math.round(point[0] * scale), nextY = Math.round(point[1] * scale);
        deltas.push(nextX - x, nextY - y);
        x = nextX; y = nextY;
      }
      return deltas;
    }));
    return { type: geometry.type, packedCoordinates: JSON.stringify(coordinates) };
  };
  const packFeatures = features => features.map(feature => ({ ...feature, geometry: packGeometry(feature.geometry) }));
  const inland = levels.every(level => level.dividers?.features);
  const selection = levels.find(level => level.minZoom === 7) ?? levels[0];
  const packagedLevels = inland ? [{ ...selection, minZoom: 0,
    ...(overlay.selection ? { features: overlay.selection.features, vertexCount: overlay.selection.vertexCount,
      selectionVersion: overlay.selection.version } : {}),
  }] : levels;
  return {
    type: 'FeatureCollection', purpose: 'display-only', schemaVersion: 1,
    encoding: inland ? 'inland-display-boundaries-v2' : 'quantized-display-boundaries-v1', scale,
    lodVersion: 'quantized-display-boundaries-v1',
    ...(inland ? { dividerLods: levels.map(level => ({ minZoom: level.minZoom,
      vertexCount: level.dividers.vertexCount, features: packFeatures(level.dividers.features) })) } : {}),
    lods: packagedLevels.map(({ dividers, ...level }) => ({ ...level, features: packFeatures(level.features) })),
  };
}
