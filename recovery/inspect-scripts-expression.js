(async () => {
  const scripts = [...document.scripts].map((script) => script.src).filter(Boolean);
  const styles = [...document.querySelectorAll('link')].map((link) => link.href).filter(Boolean);
  return { scripts, styles };
})()
