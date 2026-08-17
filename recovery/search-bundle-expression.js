(async () => {
  const source = await fetch([...document.scripts].find((script) => script.src)?.src).then((response) => response.text());
  const needles = ['pendingSaves', 'SubwayBuilderDB', 'save-and-quit', 'loadSave', 'generateSave'];
  return {
    length: source.length,
    matches: Object.fromEntries(needles.map((needle) => {
      const positions = [];
      let cursor = 0;
      while ((cursor = source.indexOf(needle, cursor)) !== -1 && positions.length < 10) {
        positions.push(cursor);
        cursor += needle.length;
      }
      return [needle, positions.map((position) => source.slice(Math.max(0, position - 1000), position + 2500))];
    })),
  };
})()
