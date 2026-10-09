// Shared across independently bundled mods, including dormant World consumers.
const KEY = '__openWorldUltraSpeedOwnershipV1__';
const registry = () => globalThis[KEY] ??= { worlds: new Map(), listeners: new Set() };
const notify = () => { for (const listener of registry().listeners) listener(); };

export function ultraSpeedWorldOwner(cityCode) {
  for (const [modId, entry] of registry().worlds) if (cityCode == null || entry.cities.has(cityCode)) return modId;
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
