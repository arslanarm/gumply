/**
 * `prefers-reduced-motion` for motion started from script (#jchhjepb, WCAG
 * 2.3.3): the CSS rule in styles.css only reaches CSS transitions, so smooth
 * scrolls and animated viewport moves ask here.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** An animation's duration in ms, or 0 when the user asked for less motion. */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/** `behavior` for scrollIntoView / scrollTo: smooth unless reduced. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
