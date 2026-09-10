// Read the live native layer, including settings supplied by the game or another
// mod. Never retain native demand arrays or React providers across tile changes.
export function findNativeDemandLayer(layers) {
  for (const layer of layers ?? []) {
    if (Array.isArray(layer)) { const found = findNativeDemandLayer(layer); if (found) return found; }
    else if (layer?.id === 'demand-points') return layer;
  }
  return null;
}

export function nativeDemandRadius(population, viewMode, logarithmic = false) {
  if (!(population > 0)) return 0;
  const homes = viewMode !== 'workers';
  return logarithmic
    ? (homes ? 4 : 3) + Math.min(Math.log(population) / Math.log(10000), 1) * (homes ? 36 : 27)
    : Math.sqrt(population / Math.PI) * (homes ? 6.5 : 2.5);
}

export function readNativeDemandPresentation(api, map, storage = globalThis.localStorage, nativeLayer = null) {
  const deck = map?.__deck;
  const layer = nativeLayer ?? findNativeDemandLayer(deck?.__openWorldMovementDeckVisibilityGuard?.nativeLayers ?? deck?.props?.layers);
  let logarithmic = false;
  try { logarithmic = JSON.parse(storage?.getItem('featureFlags') ?? '{}')?.DEMAND_DOT_SCALING === true; } catch {}
  let scale = api?.actions?.getDemandBubbleScale?.() ?? 1;
  const trigger = layer?.props?.updateTriggers?.data;
  const features = layer?.props?.data?.features ?? layer?.props?.data;
  // Selected native locations and their destinations use different curves.
  // Only calibrate from the ordinary population field, with a bounded sample.
  if (Array.isArray(trigger) && trigger[1] == null && !trigger[2] && Array.isArray(features)) {
    const points = api?.gameState?.getDemandData?.()?.points;
    for (let index = 0; index < Math.min(features.length, 32); index++) {
      const feature = features[index];
      const p = feature?.properties;
      if (p?.selected) continue;
      const point = points?.get?.(p?.id);
      const mass = trigger[0] ? point?.residents : point?.jobs;
      const base = nativeDemandRadius(mass, trigger[0] ? 'residents' : 'workers', logarithmic);
      if (base > 0 && Number.isFinite(p?.size) && p.size > 0) { scale = p.size / base; break; }
    }
  }
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    radiusScale: Number.isFinite(layer?.props?.pointRadiusScale) ? layer.props.pointRadiusScale : 1,
    logarithmic,
  };
}

// The public mod API does not expose tool selection. Read the same committed
// UI context used by native demand's click and hover handlers, without loading
// a version-specific game module or keeping an obsolete React context closure.
export function nativeDemandIgnoresClick(document = globalThis.document) {
  const root = document?.getElementById?.('root');
  for (const key of Object.keys(root ?? {})) {
    if (!key.startsWith('__reactContainer$')) continue;
    const container = root[key];
    const stack = [container?.stateNode?.current ?? container?.current ?? container];
    let inspected = 0;
    while (stack.length && inspected++ < 5000) {
      const fiber = stack.pop();
      const value = fiber?.memoizedProps?.value;
      if (value?.userActionObj && typeof value.demandStatsView === 'string') {
        return Boolean(value.userActionObj.ignoreClick);
      }
      if (fiber?.sibling) stack.push(fiber.sibling);
      if (fiber?.child) stack.push(fiber.child);
    }
  }
  return false;
}
