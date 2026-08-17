const COLORS = Object.freeze({
  border: '#394B59',
  accent: '#F2B84B',
  selected: '#173F56',
  text: '#E8F1F7',
  muted: '#91A5B5',
  warning: '#F87171',
});

function formatMoney(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString()}` : 'Money —';
}

function formatElapsed(seconds) {
  if (!Number.isFinite(Number(seconds))) return 'Time —';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return `Time ${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export class CanonicalPathPanelController {
  constructor({ selector, getContext = () => ({}) }) {
    this.selector = selector;
    this.getContext = getContext;
    this.listeners = new Set();
    this.unsubscribe = selector.subscribe?.(() => this.#emit());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.listeners) listener();
  }

  snapshot() {
    return this.selector.snapshot(this.getContext());
  }

  async choose(pathId) {
    const selection = await this.selector.choose({ ...this.getContext(), pathId });
    this.#emit();
    return selection;
  }

  async saveNew(label) {
    const result = await this.onSaveNew?.(label);
    this.#emit();
    return result;
  }

  dispose() {
    this.unsubscribe?.();
    this.listeners.clear();
  }
}

export function CanonicalPathPanel({ React, controller }) {
  const h = React.createElement;
  const [, redraw] = React.useState(0);
  const [newLabel, setNewLabel] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => controller.subscribe(() => redraw((value) => value + 1)), [controller]);
  const snapshot = controller.snapshot();
  const savedWorlds = snapshot.paths.filter((path) => path.userSaved === true);
  const choose = (pathId) => { void controller.choose(pathId).catch(() => {}); };
  const saveNew = async () => {
    const label = newLabel.trim();
    if (!label || saving || !snapshot.canSave) return;
    setSaving(true);
    try {
      await controller.saveNew(label);
      setNewLabel('');
    } catch {
      // The caller owns user-facing error reporting.
    } finally {
      setSaving(false);
    }
  };
  return h('div', { className: 'flex flex-col gap-3 p-3', style: { color: COLORS.text } },
    h('div', { className: 'text-sm font-semibold' }, 'Open World'),
    h('div', { className: 'text-xs leading-5', style: { color: COLORS.muted } },
      'Saved Worlds'),
    snapshot.waiting && h('div', {
      className: 'rounded-md border p-2 text-xs',
      style: { borderColor: COLORS.warning, color: COLORS.warning },
    }, 'Startup is waiting for this choice.'),
    h('div', { className: 'flex flex-col gap-2' },
      savedWorlds.length === 0 && h('div', {
        className: 'rounded-md border p-2 text-xs',
        style: { borderColor: COLORS.border, color: COLORS.muted },
      }, 'No saved worlds yet.'),
      ...savedWorlds.map((path) => {
      const selected = path.id === snapshot.selection?.pathId;
      return h('button', {
        key: path.id,
        type: 'button',
        className: 'rounded-md border p-2 text-left',
        style: {
          borderColor: selected ? COLORS.accent : COLORS.border,
          background: selected ? COLORS.selected : 'transparent',
          color: COLORS.text,
          cursor: 'pointer',
        },
        onClick: () => choose(path.id),
        'aria-pressed': selected,
      },
      h('div', { className: 'flex items-center justify-between gap-2' },
        h('div', { className: 'text-xs font-semibold' }, path.label),
        h('span', { className: 'text-[10px] font-mono', style: { color: selected ? COLORS.accent : COLORS.muted } }, selected ? 'Loaded' : 'Load')),
      h('div', { className: 'mt-1 text-[11px] font-mono', style: { color: COLORS.muted } },
        `${path.day == null ? 'Day —' : `Day ${path.day}`} · ${path.routeCount == null ? 'Routes —' : `${path.routeCount} routes`} · ${formatMoney(path.wallet ?? path.money)} · ${formatElapsed(path.elapsedSeconds)}`),
      path.description && h('div', { className: 'mt-1 text-[11px] leading-4', style: { color: COLORS.muted } }, path.description));
      })),
    h('div', { className: 'flex flex-col gap-2 rounded-md border p-2', style: { borderColor: COLORS.border } },
      h('div', { className: 'text-xs font-semibold' }, 'Save current world'),
      h('input', {
        value: newLabel,
        type: 'text',
        placeholder: 'World name',
        className: 'rounded-md border bg-transparent px-2 py-1 text-xs',
        style: { borderColor: COLORS.border, color: COLORS.text },
        onChange: (event) => setNewLabel(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') void saveNew(); },
        disabled: !snapshot.canSave || saving,
      }),
      h('button', {
        type: 'button',
        className: 'rounded-md border px-2 py-1 text-xs',
        style: { borderColor: COLORS.accent, color: COLORS.accent, cursor: snapshot.canSave ? 'pointer' : 'default' },
        onClick: saveNew,
        disabled: !snapshot.canSave || !newLabel.trim() || saving,
      }, saving ? 'Saving…' : 'Save current world'),
    ),
  );
}

export function SavedWorldHomeComponent({ React, selector, onLoadWorld, onNewWorld }) {
  const h = React.createElement;
  const [, redraw] = React.useState(0);
  const [loadingId, setLoadingId] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    const unsubscribe = selector.subscribe?.(() => redraw((value) => value + 1));
    const initialized = selector.initialize?.();
    if (initialized?.catch) void initialized.catch(() => {});
    return unsubscribe;
  }, [selector]);
  React.useEffect(() => {
    const marker = globalThis.document?.querySelector?.('[data-saved-world-home]');
    if (!marker) return undefined;
    let injectedSection = marker.parentElement;
    while (injectedSection?.parentElement) {
      const parent = injectedSection.parentElement;
      const className = String(parent.className ?? '');
      if (className.includes('max-w-2xl') && className.includes('flex-col')) {
        const previousOrder = injectedSection.style.order;
        injectedSection.style.order = '999';
        return () => { injectedSection.style.order = previousOrder; };
      }
      injectedSection = parent;
    }
    return undefined;
  }, []);
  const savedWorlds = selector.listPaths().filter((path) => path.userSaved === true);
  const load = async (path) => {
    if (!path?.worldId || loadingId) return;
    setLoadingId(path.id);
    setError(null);
    try {
      await onLoadWorld?.(path);
    } catch (loadError) {
      setError(loadError?.message ?? 'The saved world could not be loaded.');
      setLoadingId(null);
    }
  };
  const createNewWorld = async () => {
    if (creating || loadingId) return;
    setCreating(true);
    setError(null);
    try {
      await onNewWorld?.();
    } catch (createError) {
      setError(createError?.message ?? 'A new world could not be started.');
      setCreating(false);
    }
  };
  return h('div', {
    'data-saved-world-home': 'true',
    className: 'flex flex-col gap-2 rounded-md border p-3',
    style: { borderColor: COLORS.border, color: COLORS.text },
  },
  h('div', { className: 'text-sm font-semibold' }, 'Open World'),
  h('div', { className: 'text-xs leading-5', style: { color: COLORS.muted } },
    'Load saved world'),
  error && h('div', { className: 'text-xs', style: { color: COLORS.warning } }, error),
  savedWorlds.length === 0 && h('div', {
    className: 'rounded-md border p-2 text-xs',
    style: { borderColor: COLORS.border, color: COLORS.muted },
  }, 'No saved worlds yet.'),
  ...savedWorlds.map((path) => h('button', {
    key: path.id,
    type: 'button',
    className: 'rounded-md border p-2 text-left',
    style: {
      borderColor: COLORS.border,
      background: 'transparent',
      color: COLORS.text,
      cursor: loadingId ? 'default' : 'pointer',
      opacity: loadingId && loadingId !== path.id ? 0.55 : 1,
    },
    onClick: () => { void load(path); },
    disabled: Boolean(loadingId),
  },
  h('div', { className: 'flex items-center justify-between gap-2' },
    h('div', { className: 'text-xs font-semibold truncate' }, path.label),
    h('span', { className: 'text-[10px] font-mono', style: { color: COLORS.accent } },
      loadingId === path.id ? 'Loading…' : 'Load')),
  h('div', { className: 'mt-1 text-[11px] font-mono', style: { color: COLORS.muted } },
    `${path.day == null ? 'Day —' : `Day ${path.day}`} · ${path.routeCount == null ? 'Routes —' : `${path.routeCount} routes`} · ${formatMoney(path.wallet ?? path.money)} · ${formatElapsed(path.elapsedSeconds)}`))),
  h('button', {
    type: 'button',
    className: 'mt-1 w-full rounded-md border px-2 py-1 text-xs',
    style: {
      borderColor: COLORS.accent,
      color: COLORS.accent,
      cursor: creating || loadingId ? 'default' : 'pointer',
    },
    onClick: () => { void createNewWorld(); },
    disabled: Boolean(creating || loadingId),
  }, 'New Game'),
  );
}

export function registerSavedWorldHomeComponent({ api, selector, onLoadWorld, onNewWorld, componentId = 'saved-world-home-load' }) {
  if (typeof api?.ui?.registerComponent !== 'function') return null;
  const React = api.utils?.React;
  if (typeof React?.createElement !== 'function') return null;
  api.ui.unregisterComponent?.('main-menu', componentId);
  const registration = api.ui.registerComponent('main-menu', {
    id: componentId,
    component: () => React.createElement(SavedWorldHomeComponent, { React, selector, onLoadWorld, onNewWorld }),
  });
  return { registration, componentId };
}

export function scheduleSavedWorldHomeRegistration(register, schedule = globalThis.setTimeout) {
  if (typeof register !== 'function') return null;
  const restore = () => register();
  if (typeof schedule === 'function') return schedule(restore, 0);
  return restore();
}

export function registerCanonicalPathPanel({ api, selector, getContext, onSelection, onSaveNew, panelId = 'canonical-save-path' }) {
  if (typeof api?.ui?.addToolbarPanel !== 'function') throw new Error('ui.addToolbarPanel is unavailable');
  const React = api.utils?.React;
  if (typeof React?.createElement !== 'function') throw new Error('Native React UI is unavailable');
  api.ui.unregisterComponent?.('top-bar', panelId);
  const controller = new CanonicalPathPanelController({ selector, getContext });
  controller.onSaveNew = async (label) => {
    const result = await onSaveNew?.(label);
    if (result?.selection) await onSelection?.(result.selection);
    return result;
  };
  const originalChoose = controller.choose.bind(controller);
  controller.choose = async (pathId) => {
    const selection = await originalChoose(pathId);
    await onSelection?.(selection);
    return selection;
  };
  controller.panelRegistration = api.ui.addToolbarPanel({
    id: panelId,
    icon: 'GitBranch',
    tooltip: 'Saved worlds',
    title: 'Saved worlds',
    width: 360,
    render: () => React.createElement(CanonicalPathPanel, { React, controller }),
  });
  return controller;
}
