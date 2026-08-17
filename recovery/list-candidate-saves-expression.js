(async () => {
  const countResult = await window.electron.getSaveCount();
  const result = await window.electron.getSavesPaginated(0, countResult.count);
  return result.saves
    .filter((save) => /^NY_/.test(save.cityCode ?? '') || /new york/i.test(save.name ?? ''))
    .map((save) => ({
      id: save.id,
      autosaveId: save.autosaveId ?? null,
      name: save.name,
      timestamp: save.timestamp,
      iso: new Date(save.timestamp).toISOString(),
      cityCode: save.cityCode,
      gameSessionId: save.gameSessionId,
      stats: save.stats ?? null,
    }));
})()
