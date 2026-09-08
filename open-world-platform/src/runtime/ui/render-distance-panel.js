import { RENDER_DISTANCE } from './renderer-virtualization.js';

export const RENDER_DISTANCE_CONTROL_VERSION = 'open-world-render-distance-km-v3';

export function renderDistanceLabel(value) {
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

export function RenderDistancePanel({ React, controller, simulation }) {
  const h = React.createElement;
  const [settings, setSettings] = React.useState({ distance: controller.getRenderDistance(), shape: controller.getRenderShape?.() ?? 'circle' });
  const { distance, shape } = settings;
  const limits = controller.getRenderDistanceLimits?.() ?? RENDER_DISTANCE;
  const [simulationState, setSimulationState] = React.useState(() => simulation?.snapshot());
  React.useEffect(() => simulation?.subscribe(setSimulationState), [simulation]);
  React.useEffect(
    () => controller.subscribeRenderDistance((value) => { setSettings({ distance: value, shape: controller.getRenderShape?.() ?? 'circle' }); }),
    [controller],
  );
  const update = (event) => controller.setRenderDistance(limits.min + Number(event?.target?.value) / 1000 * (limits.max - limits.min));
  return h('div', {
    className: 'flex flex-col gap-3 p-3',
    'data-version': RENDER_DISTANCE_CONTROL_VERSION,
  },
  h('div', { className: 'flex items-center justify-between gap-3' },
    h('label', { htmlFor: 'open-world-render-distance', className: 'text-sm font-medium' }, 'Render distance'),
    h('span', { className: 'font-mono text-sm', 'aria-live': 'polite' }, renderDistanceLabel(distance))),
  h('input', {
    id: 'open-world-render-distance',
    type: 'range',
    min: 0,
    max: 1000,
    step: 1,
    value: limits.max === limits.min ? 0 : (distance - limits.min) / (limits.max - limits.min) * 1000,
    onChange: update,
    'aria-label': 'Map render distance',
    'aria-valuetext': renderDistanceLabel(distance),
    className: 'w-full accent-primary',
  }),
  h('div', { className: 'flex justify-between text-xs text-muted-foreground' },
    h('span', null, renderDistanceLabel(limits.min)), h('span', null, renderDistanceLabel(limits.max))),
  h('label', { className: 'flex items-center justify-between text-sm' }, 'Shape',
    h('select', { value: shape, 'aria-label': 'Render distance shape',
      onChange: event => { controller.setRenderShape(event.target.value); setSettings({ distance: controller.getRenderDistance(), shape: event.target.value }); } },
      h('option', { value: 'circle' }, 'Circle'), h('option', { value: 'square' }, 'Square'))),
  h('div', { className: 'rounded-md border p-2 text-xs text-muted-foreground' },
    shape === 'circle' ? 'Radius from the selected tile center.' : 'Half the side length, centered on the selected tile.'),
  h('p', { className: 'text-[11px] leading-4 text-muted-foreground' },
    'Higher distances draw more neighboring tiles and may reduce map performance.'),
  simulation && h('div', { className: 'flex flex-col gap-2 border-t pt-3' },
    h('label', { className: 'flex items-center gap-2 text-sm font-medium' },
      h('input', { type: 'checkbox', role: 'switch', id: 'open-world-cached-simulation',
        checked: simulationState?.enabled ?? false,
        onChange: event => { void simulation.setEnabled(event.target.checked); },
        'aria-label': 'Ultra-high-speed cached simulation' }),
      'Ultra-high-speed mode'),
    h('p', { className: 'text-[11px] leading-4 text-muted-foreground' },
      'Uses calculated ridership and finances. Trains, signals, crowds, and passenger movements stop simulating. Demand views keep assigned modes and routes. Delays and crowding are not modeled. Ultra speed advances time 10× faster.'),
    h('div', { className: 'text-xs', role: 'status', 'aria-live': 'polite' },
      simulationState?.error ?? (simulationState?.status === 'calculating' ? 'Calculating journeys… Time waits for the cache.'
        : simulationState?.enabled ? `${simulationState.assignedPops.toLocaleString()} pop groups assigned · ${Math.round(simulationState.dailyRidership).toLocaleString()} estimated daily rides`
          : 'Native simulation'))));
}

export function registerRenderDistanceToolbar({
  api,
  controller,
  simulation,
  panelId = 'open-world-render-distance',
} = {}) {
  if (typeof api?.ui?.addToolbarPanel !== 'function') return null;
  const React = api.utils?.React;
  if (typeof React?.createElement !== 'function') return null;
  api.ui.unregisterComponent?.('top-bar', panelId);
  const registration = api.ui.addToolbarPanel({
    id: panelId,
    icon: 'SlidersHorizontal',
    tooltip: 'Map rendering',
    title: 'Map rendering',
    width: 340,
    render: () => React.createElement(RenderDistancePanel, { React, controller, simulation }),
  });
  return { registration, panelId };
}
