/**
 * Scrolling for the Outline pane (v0.8 D1): where a heading counts as "the
 * one you're reading", and jumping to one.
 */

/** How far below the top of the scroller a jumped-to heading lands, and the line that picks the current one. */
export const OUTLINE_TOP_OFFSET = 24;

/** The page's scroll container: the main content area. */
export function scrollerOf(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(".content");
}

/** Scroll so `element` sits just below the top of its scroller. */
export function revealNearTop(element: HTMLElement): void {
  const scroller = scrollerOf(element);
  if (!scroller) {
    element.scrollIntoView({ block: "start" });
    return;
  }
  const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - OUTLINE_TOP_OFFSET;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
}
