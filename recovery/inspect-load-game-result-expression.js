(async () => {
  const filePath = 'D:\\SubwayBuilder\\_auto__2026_08_15_19_00_02_c7f16724a2ef4e7dbc4418ff6f79888c.metro';
  const result = await window.electron.loadGameFromPath(filePath);
  const summarize = (value) => ({
    type: Array.isArray(value) ? 'array' : typeof value,
    keys: value && typeof value === 'object' ? Object.keys(value) : [],
    success: value?.success,
    dataKeys: value?.data && typeof value.data === 'object' ? Object.keys(value.data) : [],
    saveKeys: value?.save && typeof value.save === 'object' ? Object.keys(value.save) : [],
    mainSaveKeys: value?.mainSave && typeof value.mainSave === 'object' ? Object.keys(value.mainSave) : [],
  });
  return summarize(result);
})()
