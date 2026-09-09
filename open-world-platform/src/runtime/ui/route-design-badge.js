// The API exposes route designs but not its RouteIcon component. These small
// DOM badges use the same shapes, proportions and font options, with no canvas,
// image requests or retained native route objects.
export function routeDesignBadge(h, route) {
  const label = route.name || route.label || route.bullet || 'Route';
  if (!route.color || route.bullet == null) return h('span', null, label);
  const size = 24, border = route.bordered ? size * 0.08 : 0;
  const shape = route.shape ?? 'circle';
  const clip = shape === 'triangle' ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
    : shape === 'diamond' ? 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' : undefined;
  const radius = shape === 'circle' ? 999 : shape === 'rounded-square' ? size * 0.18 : 0;
  let innerClip;
  if (border && shape === 'diamond') {
    const d = border * Math.SQRT2;
    innerClip = `polygon(50% ${d}px, calc(100% - ${d}px) 50%, 50% calc(100% - ${d}px), ${d}px 50%)`;
  } else if (border && shape === 'triangle') {
    innerClip = `polygon(50% ${border * 2.236}px, ${border * 1.618}px calc(100% - ${border}px), calc(100% - ${border * 1.618}px) calc(100% - ${border}px))`;
  }
  const textColor = route.textColor || '#ffffff';
  const raw = textColor.replace(/^#/, ''), hex = raw.length === 3 ? [...raw].map(c => c + c).join('') : raw;
  const inverse = /^[0-9a-f]{6}$/i.test(hex) ? `#${(0xffffff - parseInt(hex, 16)).toString(16).padStart(6, '0')}` : '#ffffff';
  const fitsSquare = [...String(route.bullet)].length <= 1 || /^[0-9]{2}$/.test(route.bullet);
  return h('span', { className: 'flex items-center gap-2', title: label, 'data-cross-route-badge': route.routeId },
    h('span', { className: 'font-mta select-none', 'aria-hidden': true, style: {
      display: 'flex', flexShrink: 0, overflow: 'hidden', boxSizing: 'border-box', minWidth: size, height: size,
      backgroundColor: route.color, color: textColor, clipPath: clip, borderRadius: radius,
      padding: border && !innerClip ? border : 0, fontSize: size * 0.6,
      fontWeight: route.font === 'bolder' ? 900 : route.font === 'lighter' ? 400 : 700,
      fontFamily: route.font === 'mono' ? 'var(--font-mono)' : undefined,
      fontStyle: route.font === 'italic' ? 'italic' : undefined,
    } }, h('span', { style: {
      display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      backgroundColor: border ? inverse : route.color, clipPath: innerClip ?? clip,
      borderRadius: Math.max(0, radius - border), paddingInline: fitsSquare ? 0 : size * 0.25,
    } }, h('span', { style: { whiteSpace: 'nowrap', lineHeight: 1, transform: `translateY(${shape === 'triangle' ? size * 0.1 : -size * 0.02}px)` } }, route.bullet || ' '))),
    h('span', null, label));
}
