import { routeDesignBadge } from './route-design-badge.js';

const MODES = [
  ['transit', 'Transit', '#0000ff', 'train'],
  ['driving', 'Driving', '#ff0000', 'car'],
  ['walking', 'Walking', '#00ff00', 'walk'],
];
const ICONS = {
  home: 'M3 10 12 3 21 10M5 9v12h14V9M9 21v-8h6v8',
  work: 'M3 7h18v14H3zM8 7V3h8v4M3 12h18M10 12v3h4v-3',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  train: 'M6 3h12v16H6zM6 11h12M12 3v8M8 22l2-3M16 22l-2-3M9 15h.01M15 15h.01',
  car: 'M3 11l3-7h12l3 7v8H3zM3 11h18M7 15h.01M17 15h.01M5 19v3M19 19v3',
  walk: 'M13 3h.01M12 7l-3 6-4 1M12 7l4 5h4M11 11l3 5 1 6M11 13l-4 9',
  people: 'M9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M3 21v-5a6 6 0 0 1 12 0v5M17 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 4v4',
};
const number = value => Math.round(value ?? 0).toLocaleString();
export function tripDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
function icon(h, name) {
  return h('svg', { key: name, width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } }, h('path', { d: ICONS[name] ?? ICONS.people }));
}
function heading(h, text, glyph) {
  return h('h3', { className: 'flex items-center gap-1 text-sm font-semibold' }, glyph && icon(h, glyph), text);
}
function button(h, text, onClick, props = {}) {
  return h('button', { type: 'button', className: 'rounded border px-2 py-1.5 text-xs hover:bg-secondary focus-visible:outline focus-visible:outline-2', onClick, ...props }, text);
}
function rows(h, values) {
  return h('div', { className: 'flex flex-col gap-2 text-xs' }, ...values.map(([label, value]) => h('div', { key: label, className: 'flex justify-between gap-3' },
    h('span', { className: 'text-muted-foreground' }, label), h('span', { className: 'text-right tabular-nums' }, value))));
}
function modeRows(h, choice, population) {
  const total = population || MODES.reduce((sum, [key]) => sum + (choice?.[key] ?? 0), 0);
  const known = MODES.reduce((sum, [key]) => sum + (choice?.[key] ?? 0), 0);
  return h('div', { className: 'flex flex-col gap-2' }, ...MODES.map(([key, label, color, glyph]) => {
    const count = choice?.[key] ?? 0, percent = total ? count / total * 100 : 0;
    return h('div', { key },
      h('div', { className: 'mb-1 flex items-center gap-1 text-xs' }, icon(h, glyph), h('span', { className: 'flex-1 font-medium' }, label),
        h('span', { className: 'tabular-nums' }, number(count)), h('span', { className: 'w-12 text-right tabular-nums' }, `${percent.toFixed(1)}%`)),
      h('div', { className: 'h-1.5 overflow-hidden rounded bg-secondary' }, h('div', { style: { width: `${Math.min(100, percent)}%`, height: '100%', backgroundColor: color } })));
  }), total > known + 0.5 && h('p', { className: 'text-xs text-muted-foreground' }, `${number(total - known)} commuters awaiting mode calculation`));
}
function modeStrip(h, choice, mass) {
  return h('div', { className: 'flex h-2 flex-1 overflow-hidden rounded bg-secondary', 'aria-hidden': true }, ...MODES.map(([key, , color]) =>
    h('span', { key, style: { width: `${mass ? (choice?.[key] ?? 0) / mass * 100 : 0}%`, backgroundColor: color } })));
}
function histogram(h, title, bins) {
  const totals = bins.map(bin => MODES.reduce((sum, [key]) => sum + bin[key], 0));
  const max = Math.max(1, ...totals);
  return h('section', { className: 'flex flex-col gap-2', 'aria-label': title }, heading(h, title, 'clock'),
    h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 64 } }, ...bins.map((bin, hour) =>
      h('div', { key: hour, role: 'img', 'aria-label': `${hour}:00: ${number(totals[hour])} commuters`,
        title: `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59: ${number(totals[hour])} commuters`,
        style: { flex: 1, display: 'flex', flexDirection: 'column-reverse', height: `${totals[hour] / max * 100}%` } },
      ...MODES.map(([key, , color]) => h('span', { key, style: { height: `${totals[hour] ? bin[key] / totals[hour] * 100 : 0}%`, backgroundColor: color } }))))),
    h('div', { className: 'flex justify-between text-[10px] text-muted-foreground' }, ...['12am', '6am', '12pm', '6pm', '12am'].map((label, i) => h('span', { key: i }, label))));
}

export function demandPanelContent({ h, controller: c, snapshot: s, point, pop, limit, setLimit, page, setPage, advanced, panelRef }) {
  const section = (...children) => h('section', { className: 'flex flex-col gap-2 border-t pt-3' }, ...children);
  const back = (text, action) => button(h, `‹ ${text}`, action, { className: 'self-start text-xs text-muted-foreground hover:text-primary' });
  const content = [];
  if (pop) {
    const comparison = pop.modeChoiceComparison, driving = comparison?.driving, walking = comparison?.walking, path = pop.transitPath;
    content.push(back('Demand point details', () => c.backToPoint()), heading(h, `${number(pop.mass)} Commuters`, 'people'),
      heading(h, 'Transportation choices'), modeRows(h, pop.modeChoice, pop.mass),
      h('div', { className: 'flex gap-2' }, button(h, 'Show whole route', () => c.fitRoute(panelRef?.current?.getBoundingClientRect()), { disabled: s.routeStatus === 'loading' })),
      h('p', { role: 'status', className: 'text-xs text-muted-foreground' }, s.routeStatus === 'loading' ? 'Loading driving route…'
        : s.routeStatus === 'geometric-no-road-route' || s.routeStatus === 'geometric-fallback' ? 'No road route found. Showing an approximate connection.' : 'Driving route shown in red.'),
      section(heading(h, 'Transit paths', 'train'), path?.available
        ? h('div', { className: 'flex flex-col gap-2 text-xs' }, ...[path.continuousLeg, path.homeLeg, path.intermediateLeg, path.workLeg].filter(leg => leg?.available).map((leg, i) =>
          h('div', { key: i }, h('div', null, `${leg.originStationName ?? 'Origin station'} → ${leg.destinationStationName ?? 'Destination station'}`),
            h('div', { className: 'mt-1 flex flex-col gap-1' }, ... (leg.routes ?? []).filter((route, index, routes) =>
              index === 0 || route.routeId !== routes[index - 1].routeId).map((route, index) =>
              h('div', { key: index }, routeDesignBadge(h, c.routeDesign(route))))))),
          h('div', { className: 'font-medium' }, tripDuration(path.totalClockSeconds ?? path.totalSeconds)))
        : h('p', { className: 'text-xs text-muted-foreground' }, 'No complete transit path found.')),
      section(heading(h, 'Driving', 'car'), rows(h, [
        ['Driving time', tripDuration(driving?.clockSeconds ?? pop.drivingSeconds)],
        ['Driving in traffic', tripDuration(driving?.congestedClockSeconds)],
        ['Perceived time', tripDuration(driving?.perceivedSeconds)],
        ['Driving distance', Number.isFinite(driving?.distanceMetres ?? pop.drivingDistance) ? `${((driving?.distanceMetres ?? pop.drivingDistance) / 1000).toFixed(1)} km` : '—'],
        ['Driving and parking cost', Number.isFinite(driving?.moneyCost) ? `$${driving.moneyCost.toFixed(2)}` : '—'],
      ])),
      section(heading(h, 'Walking', 'walk'), rows(h, [['Walking time', tripDuration(walking?.clockSeconds)]])),
      section(h('div', { className: 'grid grid-cols-2 gap-2' }, ...[['home', 'Home point'], ['work', 'Work point']].map(([kind, label]) =>
        button(h, [h('span', { key: 'label', className: 'flex items-center justify-center gap-1' }, icon(h, kind), label),
          h('span', { key: 'tile', className: 'mt-1 block text-muted-foreground' }, c.tileName(pop[kind].tileId))], () => c.focusEndpoint(kind), { key: kind }))),
        rows(h, [['Home departure time', pop.homeDepartureTime ?? '—'], ['Work departure time', pop.workDepartureTime ?? '—']])),
      advanced);
  } else {
    const summary = c.model.summary(s.viewMode, s.selectedPointId);
    if (point) content.push(back('All cross-city demand', () => c.clearSelection()), heading(h, 'Demand point details'),
      h('p', { className: 'text-xs text-muted-foreground' }, c.tileName(point.point.tileId)));
    content.push(h('div', { className: 'flex gap-1' }, ...[['residents', 'Residents', 'home'], ['workers', 'Workers', 'work']].map(([view, label, glyph]) =>
      button(h, [icon(h, glyph), label], () => c.setViewMode(view), { key: view, 'aria-pressed': s.viewMode === view,
        className: `flex flex-1 items-center justify-center gap-2 rounded border py-2 text-xs ${s.viewMode === view ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-secondary/80'}` }))),
      h('div', { className: 'flex items-center justify-between gap-2 text-xs' },
        h('label', { className: 'flex items-center gap-2' }, h('input', { type: 'checkbox', checked: s.faded, onChange: e => c.setFaded(e.target.checked) }), 'Fade demand layer'),
        h('select', { 'aria-label': 'Map travel mode', value: s.modeFilter, onChange: e => c.setModeFilter(e.target.value), className: 'rounded border bg-panel px-1 py-1 text-xs' },
          ...[['all', 'All modes'], ...MODES.map(([key, label]) => [key, label])].map(([key, label]) => h('option', { key, value: key }, label)))),
      !point && h('p', { className: 'text-xs text-muted-foreground' }, 'Click a demand dot to inspect its commuters and destinations.'),
      heading(h, point ? (s.viewMode === 'workers' ? 'Worker mode share' : 'Resident mode share') : 'Cross-city demand stats', 'people'),
      modeRows(h, summary.modeChoice, summary.population));
    if (point) {
      content.push(heading(h, `${number(point.population)} ${s.viewMode === 'workers' ? 'Workers' : 'Residents'} (${number(point.popCount)} ${point.popCount === 1 ? 'pop' : 'pops'})`, s.viewMode === 'workers' ? 'work' : 'home'),
        h('div', { className: 'flex flex-col gap-1', style: { maxHeight: 280, overflowY: 'auto' } }, ...point.pops.map(item => {
          const destination = s.viewMode === 'workers' ? item.home : item.work;
          return button(h, [h('div', { key: 'counts', className: 'flex items-center gap-2' }, icon(h, 'people'), h('span', null, number(item.mass)),
            h('span', { className: 'text-muted-foreground' }, item.homeDepartureTime ?? '—'), modeStrip(h, item.modeChoice, item.mass)),
          h('div', { key: 'destination', className: 'mt-1 flex justify-between gap-2 text-muted-foreground' }, h('span', null, `${s.viewMode === 'workers' ? 'From' : 'To'} ${c.tileName(destination.tileId)}`), h('span', null, tripDuration(item.drivingSeconds)))],
          () => c.selectPop(item.index), { key: item.id, 'data-cross-pop-id': item.id,
            'aria-label': `${number(item.mass)} commuters ${s.viewMode === 'workers' ? 'from' : 'to'} ${c.tileName(destination.tileId)}, driving ${tripDuration(item.drivingSeconds)}`,
            className: 'rounded bg-secondary/60 px-2 py-1.5 text-left text-xs hover:bg-secondary focus-visible:outline focus-visible:outline-2' });
        })),
        h('div', { className: 'flex justify-between gap-2' }, page > 0 && button(h, 'Previous', () => setPage(Math.max(0, page - 40))),
          page === 0 && limit === 5 && point.popCount > 5 ? button(h, `Show ${Math.min(35, point.popCount - 5)} more`, () => setLimit(40))
            : page + limit < point.popCount && button(h, 'Next 40', () => { setPage(page + limit); setLimit(40); })));
    } else content.push(h('p', { className: 'text-xs text-muted-foreground' }, `${number(s.stats.population)} commuters across ${number(s.stats.points)} locations`));
    content.push(section(histogram(h, 'Home departure times', summary.departures)), section(histogram(h, 'Work departure times', summary.returns)));
  }
  return h('div', { ref: panelRef, className: 'flex flex-col gap-3 p-2 text-sm', 'data-cross-demand-version': s.version,
    style: { maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', fontFamily: 'inherit' },
    onKeyDown: e => { if (e.key === 'Escape' && (s.selectedPopIndex != null || s.selectedPointId)) { e.stopPropagation(); pop ? c.backToPoint() : c.clearSelection(); } } }, ...content);
}
