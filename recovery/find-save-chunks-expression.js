(async () => {
  const source = await fetch([...document.scripts].find((script) => script.src)?.src).then((response) => response.text());
  const matches = [...source.matchAll(/[A-Za-z0-9_./-]*unifiedSaveLoad[A-Za-z0-9_.-]*\.js/g)].map((match) => ({ value: match[0], index: match.index }));
  const dynamic = [...source.matchAll(/\.\/[^"']+\.js/g)].map((match) => match[0]).filter((value) => /save|load/i.test(value));
  return { matches, dynamic: [...new Set(dynamic)] };
})()
