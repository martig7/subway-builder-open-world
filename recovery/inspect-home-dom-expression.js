(() => ({
  href: location.href,
  title: document.title,
  text: document.body?.innerText?.slice(0, 4000),
  buttons: [...document.querySelectorAll('button')].map((button, index) => ({
    index,
    text: button.innerText,
    aria: button.getAttribute('aria-label'),
    disabled: button.disabled,
  })),
}))()
