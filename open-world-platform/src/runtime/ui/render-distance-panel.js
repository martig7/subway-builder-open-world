import { RENDER_DISTANCE, normalizeRenderDistance } from './renderer-virtualization.js';

export const RENDER_DISTANCE_CONTROL_VERSION = 'open-world-render-distance-v1';

const FOOTPRINT_LABELS = Object.freeze({
  1: 'Selected tile only',
  2: 'Selected tile plus directly bordering tiles',
  3: '3 × 3 tiles (default)',
  4: '3 × 3 plus one tile on each side',
  5: '5 × 5 tiles',
  6: '5 × 5 plus three tiles on each side',
  7: '7 × 7 tiles',
  8: '7 × 7 plus five tiles on each side',
  9: '9 × 9 tiles',
});

export function renderDistanceLabel(value) {
  return FOOTPRINT_LABELS[normalizeRenderDistance(value)];
}

export function RenderDistancePanel({ React, controller }) {
  const h = React.createElement;
  const [distance, setDistance] = React.useState(controller.getRenderDistance());
  React.useEffect(
    () => controller.subscribeRenderDistance((value) => setDistance(value)),
    [controller],
  );
  const update = (event) => controller.setRenderDistance(event?.target?.value);
  return h('div', {
    className: 'flex flex-col gap-3 p-3',
    'data-version': RENDER_DISTANCE_CONTROL_VERSION,
  },
  h('div', { className: 'flex items-center justify-between gap-3' },
    h('label', { htmlFor: 'open-world-render-distance', className: 'text-sm font-medium' }, 'Render distance'),
    h('span', { className: 'font-mono text-sm', 'aria-live': 'polite' }, String(distance))),
  h('input', {
    id: 'open-world-render-distance',
    type: 'range',
    min: RENDER_DISTANCE.min,
    max: RENDER_DISTANCE.max,
    step: 1,
    value: distance,
    onChange: update,
    'aria-label': 'Map render distance',
    'aria-valuetext': renderDistanceLabel(distance),
    className: 'w-full accent-primary',
  }),
  h('div', { className: 'flex justify-between px-1 font-mono text-[10px] text-muted-foreground', 'aria-hidden': true },
    ...Array.from({ length: RENDER_DISTANCE.max }, (_, index) => h('span', { key: index + 1 }, String(index + 1)))),
  h('div', { className: 'rounded-md border p-2 text-xs text-muted-foreground' }, renderDistanceLabel(distance)),
  h('p', { className: 'text-[11px] leading-4 text-muted-foreground' },
    'Higher distances draw more neighboring tiles and may reduce map performance.'));
}

export function registerRenderDistanceToolbar({
  api,
  controller,
  panelId = 'open-world-render-distance',
} = {}) {
  if (typeof api?.ui?.addToolbarPanel !== 'function') return null;
  const React = api.utils?.React;
  if (typeof React?.createElement !== 'function') return null;
  api.ui.unregisterComponent?.('top-bar', panelId);
  const registration = api.ui.addToolbarPanel({
    id: panelId,
    icon: 'SlidersHorizontal',
    tooltip: 'Map render distance',
    title: 'Map rendering',
    width: 340,
    render: () => React.createElement(RenderDistancePanel, { React, controller }),
  });
  return { registration, panelId };
}
