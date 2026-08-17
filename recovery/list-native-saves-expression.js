(async () => {
  const electron = window.electron;
  const keys = electron ? Reflect.ownKeys(electron).map(String).sort() : [];
  const count = await electron?.getSaveCount?.();
  const requested = Number(count?.count ?? count?.data ?? count ?? 200) || 200;
  const paginated = await electron?.getSavesPaginated?.(0, requested);
  const recent = !paginated && electron?.getMostRecentSaves ? await electron.getMostRecentSaves(requested) : null;
  return { keys, count, paginated, recent };
})()
