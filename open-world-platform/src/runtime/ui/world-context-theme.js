export const WORLD_CONTEXT_THEME_VERSION = 'native-world-context-theme-lit-water-v2';
const cssColors = new Map();

function rgb(value) {
  if (value && Number.isFinite(value.r)) return [value.r, value.g, value.b];
  if (typeof value !== 'string') return null;
  if (cssColors.has(value)) return cssColors.get(value);
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  // Browser CSS parsing supports named colors, rgb(), and custom theme colors.
  const context = globalThis.document?.createElement?.('canvas')?.getContext?.('2d');
  if (!context) return null;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const result = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n / 255);
  if (cssColors.size > 128) cssColors.clear();
  cssColors.set(value, result);
  return result;
}

// Match MapLibre's fillExtrusion vertex shader for a horizontal, zero-height
// surface. A plain fill is required for correct ordering beneath native layers;
// copying the unlit paint alone loses the shader's ambient/directional light.
export function renderedWaterColor(map, water, raw) {
  if (water?.type !== 'fill-extrusion') return raw;
  const evaluated = water.paint?.get?.('fill-extrusion-color')?.value;
  const color = rgb(raw) ?? rgb(evaluated?.kind === 'constant' ? evaluated.value : null);
  if (!color) return raw;
  const light = map.getLight?.() ?? {};
  // Read requested light values, not the previous frame's evaluated Light:
  // styledata fires before that frame is recalculated on theme replacement.
  const lightColor = rgb(light.color ?? '#ffffff');
  if (!lightColor) return raw;
  const intensity = light.intensity ?? .5;
  const spherical = light.position ?? [1.15, 210, 30];
  const z = spherical[0] * Math.cos(spherical[2] * Math.PI / 180);
  const luminance = color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
  const directional = (1 - intensity) + (Math.max(1 - luminance + intensity, 1) - (1 - intensity)) * Math.max(0, Math.min(1, z));
  const lit = color.map((c, i) => Math.max(.3 * (1 - lightColor[i]), Math.min(1, (c + .03) * directional * lightColor[i])));
  return `rgb(${lit.map(c => Math.round(c * 255)).join(', ')})`;
}

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
    water: renderedWaterColor(map, water, paintValue(map, water, water?.type === 'fill-extrusion' ? 'fill-extrusion-color' : 'fill-color')
      ?? fallbackColors.water),
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
      ['open-world-native-land-backing', colors.land],
      ['open-world-vegetation', colors.vegetation],
    ]) {
      const layer = map.getLayer?.(id);
      if (!layer || JSON.stringify(paintValue(map, layer, 'fill-color')) === JSON.stringify(color)) continue;
      map.setPaintProperty?.(id, 'fill-color', color);
    }
    map.__openWorldWorldContextTheme = { version: WORLD_CONTEXT_THEME_VERSION, ...colors };
  } finally { syncingMaps.delete(map); }
}
