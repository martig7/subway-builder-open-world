import { RENDER_DISTANCE } from './renderer-virtualization.js';
import { prototypeSaveProgressText } from '../prototype-save-progress.js';

export const RENDER_DISTANCE_CONTROL_VERSION = 'open-world-render-distance-km-v4';

// Native option popups otherwise retain a light background in the dark theme.
const SHAPE_SELECT_STYLE = Object.freeze({
  color: 'hsl(var(--foreground))',
  backgroundColor: 'hsl(var(--background))',
});

export function renderDistanceLabel(value) {
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

const mebibytes = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

export function RenderDistancePanel({ React, controller, simulation, saveWriter }) {
  const h = React.createElement;
  const [settings, setSettings] = React.useState({ distance: controller.getRenderDistance(), shape: controller.getRenderShape?.() ?? 'circle' });
  const { distance, shape } = settings;
  const limits = controller.getRenderDistanceLimits?.() ?? RENDER_DISTANCE;
  const [simulationState, setSimulationState] = React.useState(() => simulation?.snapshot());
  React.useEffect(() => simulation?.subscribe(setSimulationState), [simulation]);
  const [saveState, setSaveState] = React.useState(() => saveWriter?.snapshot());
  React.useEffect(() => saveWriter?.subscribe(setSaveState), [saveWriter]);
  React.useEffect(() => {
    // Re-probe when the panel opens while unconfigured (e.g. the writer
    // started after the mod loaded). The controller throttles attempts so
    // repeated opens stay quiet when no writer answers.
    void saveWriter?.reconnect?.().catch(() => {});
  }, [saveWriter]);
  React.useEffect(
    () => controller.subscribeRenderDistance((value) => { setSettings({ distance: value, shape: controller.getRenderShape?.() ?? 'circle' }); }),
    [controller],
  );
  const update = (event) => controller.setRenderDistance(limits.min + Number(event?.target?.value) / 1000 * (limits.max - limits.min));
  const phases = !saveState?.configured || !saveState.last ? [] : [
    saveState.last.generateMs != null && `generate ${seconds(saveState.last.generateMs)}`,
    saveState.last.settleMs != null && `settle ${seconds(saveState.last.settleMs)}`,
    saveState.last.encodeMs != null && `encode ${seconds(saveState.last.encodeMs)}`,
    saveState.last.transferMs != null && `transfer ${seconds(saveState.last.transferMs)}`,
  ].filter(Boolean);
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
      className: 'rounded-md border px-2 py-1', style: SHAPE_SELECT_STYLE,
      onChange: event => { controller.setRenderShape(event.target.value); setSettings({ distance: controller.getRenderDistance(), shape: event.target.value }); } },
      h('option', { value: 'circle', style: SHAPE_SELECT_STYLE }, 'Circle'),
      h('option', { value: 'square', style: SHAPE_SELECT_STYLE }, 'Square'))),
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
      'Uses calculated ridership and finances. Trains, signals, crowds, and passenger movements stop simulating. Demand views keep assigned modes and routes. Delays and crowding are not modeled. Ultra speed advances time 10× faster. Your choice is remembered between sessions.'),
    h('div', { className: 'text-xs', role: 'status', 'aria-live': 'polite' },
      simulationState?.error ?? (simulationState?.status === 'restoring' ? 'Restoring Ultra-high-speed mode after the network loads…'
        : simulationState?.status === 'calculating' ? 'Calculating journeys… Time waits for the cache.'
        : simulationState?.enabled ? `${simulationState.assignedPops.toLocaleString()} pop groups assigned · ${Math.round(simulationState.dailyRidership).toLocaleString()} estimated daily rides`
          : 'Native simulation'))),
  h('div', { className: 'flex flex-col gap-2 border-t pt-3' },
    h('label', { className: 'flex items-center gap-2 text-sm font-medium' },
      h('input', { type: 'checkbox', role: 'switch', checked: saveState?.enabled ?? false,
        disabled: !saveState?.configured && !saveState?.enabled,
        onChange: event => saveWriter?.setEnabled(event.target.checked),
        'aria-label': 'Experimental tile-server autosaves' }), 'Experimental tile-server autosaves'),
    h('p', { className: 'text-[11px] leading-4 text-muted-foreground' },
      'Pauses simulation and editing while saving. Uses normal game files. Failures are reported without switching to native autosaves. Your choice is remembered between sessions.'),
    h('div', { role: 'status', className: 'text-xs', 'aria-live': 'polite' },
      saveState?.error ?? (!saveState?.configured ? 'Save writer unavailable. Start or reconnect the local tile server.'
        : saveState.transport === 'native' ? 'Native autosave selected: experimental autosaves are disabled.'
        : saveState.status === 'saving'
          ? prototypeSaveProgressText(saveState)
          : saveState.last
            ? `Saved ${mebibytes(saveState.last.bytes)} in ${seconds(saveState.last.durationMs)}` : 'Ready')),
    phases.length > 0 && h('div', { className: 'text-xs text-muted-foreground' },
      `${saveState.status === 'saved' ? '' : 'Last completed save: '}${phases.join(' · ')}`),
    !saveState?.configured && saveState?.transport === 'native'
      && h('div', { className: 'text-xs text-muted-foreground' }, 'Native autosave selected: experimental autosaves are disabled.'),
    saveState?.configured && saveState.enabled && ['failed', 'cancelled'].includes(saveState.status)
      && h('button', { type: 'button', className: 'rounded-md border px-2 py-1 text-xs',
        onClick: () => { void saveWriter.run().catch(() => {}); } }, 'Retry experimental save')));
}

export function registerRenderDistanceToolbar({
  api,
  controller,
  simulation,
  saveWriter,
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
    render: () => React.createElement(RenderDistancePanel, { React, controller, simulation, saveWriter }),
  });
  return { registration, panelId };
}
