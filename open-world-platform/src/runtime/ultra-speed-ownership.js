// Shared across independently bundled mods, including dormant World consumers.
const KEY = '__openWorldUltraSpeedOwnershipV1__';
const registry = () => globalThis[KEY] ??= { worlds: new Map(), listeners: new Set() };
const notify = () => { for (const listener of registry().listeners) listener(); };

/** Registration proves this is a World consumer, but only the host knows
 * whether it is still loaded. Native reload leaves globals from disabled mods. */
export function ultraSpeedWorldOwner(cityCode, mods) {
  let loaded = null;
  try {
    const list = mods?.getLoadedMods?.();
    if (Array.isArray(list)) loaded = new Set(list.map(mod => mod.id));
  } catch { /* Older hosts without a working mod registry retain lease behavior. */ }
  for (const [modId, entry] of registry().worlds) {
    if (cityCode != null && !entry.cities.has(cityCode)) continue;
    if (loaded && !loaded.has(modId)) continue;
    if (!loaded && typeof mods?.isLoaded === 'function') {
      try { if (!mods.isLoaded(modId)) continue; } catch { /* Preserve an unverified owner. */ }
    }
    return modId;
  }
  return null;
}
export function subscribeUltraSpeedOwnership(listener) {
  registry().listeners.add(listener);
  return () => registry().listeners.delete(listener);
}
export function registerWorldUltraSpeedOwner(modId, cities) {
  const entry = { cities: new Set(cities) }, shared = registry();
  shared.worlds.set(modId, entry); notify();
  return () => {
    if (shared.worlds.get(modId) !== entry) return;
    shared.worlds.delete(modId); notify();
  };
}
