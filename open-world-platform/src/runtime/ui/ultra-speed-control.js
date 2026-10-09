export function UltraSpeedControl({ React, simulation, id = 'open-world-cached-simulation', hideTrains = true }) {
  const h = React.createElement;
  const [state, setState] = React.useState(() => simulation.snapshot());
  React.useEffect(() => simulation.subscribe(setState), [simulation]);
  return h('div', { className: 'flex flex-col gap-2' },
    h('label', { className: 'flex items-center gap-2 text-sm font-medium' },
      h('input', { type: 'checkbox', role: 'switch', id, checked: state?.enabled ?? false,
        disabled: state?.status === 'open-world' || state?.status === 'unavailable',
        onChange: event => { void simulation.setEnabled(event.target.checked); },
        'aria-label': 'Ultra-high-speed cached simulation' }), 'Ultra-high-speed mode'),
    h('p', { className: 'text-[11px] leading-4 text-muted-foreground' },
      `Uses calculated ridership and finances. Trains go out of service${hideTrains ? ' and disappear from the map' : ''}; trains, signals, crowds, and passenger movements stop simulating. Trains resume in native mode. Demand views keep assigned modes and routes. Delays and crowding are not modeled. Ultra speed advances time 10× faster. Your choice is remembered between sessions.`),
    h('div', { className: 'text-xs', role: 'status', 'aria-live': 'polite' },
      state?.error ?? (state?.status === 'open-world' ? 'Ultra speed is included in Open World. Use its Map rendering panel.'
        : state?.status === 'unavailable' ? 'Load a city to use Ultra speed.'
        : state?.status === 'restoring' ? 'Restoring Ultra-high-speed mode after the network loads…'
        : state?.status === 'calculating' ? 'Calculating journeys… Time waits for the cache.'
        : state?.enabled ? `${(state.assignedPops ?? 0).toLocaleString()} pop groups assigned · ${Math.round(state.dailyRidership ?? 0).toLocaleString()} estimated daily rides`
        : 'Native simulation')));
}
