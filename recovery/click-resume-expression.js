(() => {
  const candidates = [...document.querySelectorAll('a, button, [role="button"], div')];
  const target = candidates.find((element) => element.textContent?.trim() === 'Resume');
  if (!target) {
    return { clicked: false, href: location.href };
  }
  target.click();
  return {
    clicked: true,
    tagName: target.tagName,
    role: target.getAttribute('role'),
    className: target.className,
    href: target.getAttribute('href'),
  };
})()
