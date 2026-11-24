/**
 * #fw97pkjh (a11y): where focus goes when the element it should return to is
 * gone, or was never there (a page opened by URL has focus on `<body>`).
 * Never `<body>`: keyboard and screen-reader users would lose their place.
 * The open view's main region is the place: its heading (the page title),
 * else the region itself, made focusable for this without joining Tab order.
 */

/** True when `element` is a real place to put focus back: on the page and not `<body>`. */
export function isFocusReturnTarget(element: Element | null | undefined): element is HTMLElement {
  return !!element && element.isConnected && element !== element.ownerDocument.body && typeof (element as HTMLElement).focus === "function";
}

/** Focus the open view's main region (its heading, else the region). False when there is none. */
export function focusMainRegion(doc: Document = document): boolean {
  const main = doc.querySelector<HTMLElement>("main.content");
  const target = main?.querySelector<HTMLElement>("h1") ?? main;
  if (!target) return false;
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}
