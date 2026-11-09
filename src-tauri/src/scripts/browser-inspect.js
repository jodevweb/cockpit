(() => {
  const el = document.elementFromPoint(__X__, __Y__);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  let component = null, source = null;
  const key = Object.keys(el).find((name) => name.startsWith("__reactFiber$"));
  for (let fiber = key ? el[key] : null; fiber && !(component && source); fiber = fiber.return) {
    const type = fiber.type;
    const name = typeof type === "function" ? (type.displayName || type.name)
      : type && typeof type === "object" ? (type.displayName || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name)))
      : null;
    if (!component && name && /^[A-Z]/.test(name)) component = name;
    if (!source && fiber._debugSource) source = fiber._debugSource.fileName + ":" + fiber._debugSource.lineNumber;
  }
  const path = [];
  for (let node = el; node && node.nodeType === 1 && path.length < 4; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += "#" + node.id;
    else if (node.classList.length) part += "." + [...node.classList].slice(0, 2).join(".");
    path.unshift(part);
  }
  return {
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 90),
    testid: el.getAttribute("data-testid"),
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    selector: path.join(" > "),
    component,
    source,
    url: location.href,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
})()