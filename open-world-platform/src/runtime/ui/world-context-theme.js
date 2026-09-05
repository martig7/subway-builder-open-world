export const WORLD_CONTEXT_THEME_VERSION = 'native-world-context-theme-v1';

const syncingMaps = new WeakSet();
const fallbackColors = Object.freeze({ land: '#1c3046', water: '#102f68' });

function paintValue(map, layer, property) {
  if (!layer) return null;
  try {
    return map.getPaintProperty?.(layer.id, property) ?? layer.paint?.[property] ?? null;
  } catch { return layer.paint?.[property] ?? null; }
}

export function readWorldContextTheme(map) {
  let background;
  let water;
  let layers = [];
  try {
    background = map?.getLayer?.('background');
    water = map?.getLayer?.('water');
    // Avoid serializing the entire style on every styledata notification in
    // the native case. Other style producers can still use source-layer IDs.
    if (background?.type !== 'background' || !water) layers = map?.getStyle?.()?.layers ?? [];
  } catch {}
  const native = layers.filter((layer) => !layer.id?.startsWith('open-world-'));
  // Native 1.7 uses its background as the base land surface, and a water
  // fill-extrusion (height zero). Read rendered paint, not theme names or
  // localStorage, so light/dark presets and custom palettes share one source.
  background = background?.type === 'background' ? background : native.find((layer) => layer.type === 'background');
  water = water
    ?? native.find((layer) => layer['source-layer'] === 'water'
      && ['fill', 'fill-extrusion'].includes(layer.type));
  return {
    land: paintValue(map, background, 'background-color') ?? fallbackColors.land,
    vegetation: paintValue(map, map?.getLayer?.('parks-large') ?? map?.getLayer?.('parks-small'), 'fill-extrusion-color') ?? '#2a513c',
    water: paintValue(map, water, water?.type === 'fill-extrusion' ? 'fill-extrusion-color' : 'fill-color')
      ?? fallbackColors.water,
  };
}

export function syncWorldContextTheme(map) {
  if (!map || syncingMaps.has(map)) return;
  syncingMaps.add(map);
  try {
    const colors = readWorldContextTheme(map);
    for (const [id, color] of [
      ['open-world-ocean', colors.water],
      ['open-world-land', colors.land],
      ['open-world-land-high-zoom', colors.land],
      ['open-world-vegetation', colors.vegetation],
    ]) {
      const layer = map.getLayer?.(id);
      if (!layer || JSON.stringify(paintValue(map, layer, 'fill-color')) === JSON.stringify(color)) continue;
      map.setPaintProperty?.(id, 'fill-color', color);
    }
    map.__openWorldWorldContextTheme = { version: WORLD_CONTEXT_THEME_VERSION, ...colors };
  } finally { syncingMaps.delete(map); }
}
