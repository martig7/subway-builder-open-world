(async () => {
  const get = () => window.__subwayBuilder_storeCallbacks__.getState();
  const controller = window.__japanActiveRuntimeV1__.cachedSimulation;
  const paused = get().timeConfig.paused, speed = get().timeConfig.timeSpeed;
  get().setTimeConfig({ paused: true });
  await controller.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  const before = structuredClone(controller.snapshot()), original = get().handleIncrementGameState;
  const ticks = [], frames = [], tasks = []; let running = true, last = null;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, ms: entry.duration });
  });
  observer.observe({ entryTypes: ['longtask'] });
  const frame = time => { if (last != null) frames.push({ start: last, ms: time - last }); last = time; if (running) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const wrapped = async function (...args) {
    const from = get().timeConfig.elapsedSeconds, start = performance.now();
    try { return await original.apply(this, args); }
    finally { const to = get().timeConfig.elapsedSeconds;
      ticks.push({ start, ms: performance.now() - start, from, to, hour: Math.floor(from / 3600) !== Math.floor(to / 3600) }); }
  };
  get().handleIncrementGameState = wrapped;
  const start = performance.now(), from = get().timeConfig.elapsedSeconds;
  try {
    get().setTimeConfig({ paused: false, timeSpeed: 'ultrafast' });
    await new Promise(resolve => setTimeout(resolve, 20000));
    get().setTimeConfig({ paused: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    const hours = ticks.filter(row => row.hour);
    const overlaps = row => hours.some(tick => row.start + row.ms >= tick.start && row.start <= tick.start + tick.ms);
    const stats = rows => { const n = rows.map(r => r.ms).sort((a,b) => a-b); return { count:n.length, median:n[Math.floor(n.length*.5)]??0, p95:n[Math.floor(n.length*.95)]??0, max:n.at(-1)??0 }; };
    return { before, after:controller.snapshot(), from, to:get().timeConfig.elapsedSeconds, wallMs:performance.now()-start,
      hourTicks:stats(hours), frameStats:stats(frames), hourlyFrames:stats(frames.filter(overlaps)), longTasks:stats(tasks),
      hourlyLongTasks:stats(tasks.filter(overlaps)), ticks, frames, tasks,
      topology:{stations:get().stations.length,routes:get().routes.length,tracks:get().tracks.length}, save:get().currentSaveInfo };
  } finally {
    running = false; observer.disconnect();
    if (get().handleIncrementGameState === wrapped) get().handleIncrementGameState = original;
    get().setTimeConfig({ paused, timeSpeed:speed });
  }
})()
