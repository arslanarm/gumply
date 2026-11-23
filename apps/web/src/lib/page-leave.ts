import type { PageId } from "@gumply/core";

/**
 * D41: leaving a page ends its editing session (the server keeps its last
 * state as a version, if it was edited). Call the returned function with the
 * open page's id whenever it may have changed; `onLeave` runs only when it
 * really did, with the page that was left.
 *
 * Opening a page never counts as leaving one, and the same id twice is a
 * no-op: React StrictMode's double effect run on mount (dev) used to end the
 * session of the page just opened (#fr5baurg).
 */
export function pageLeaveTracker(onLeave: (left: PageId) => void): (open: PageId | null) => void {
  let last: PageId | null = null;
  return (open) => {
    if (last !== null && last !== open) onLeave(last);
    last = open;
  };
}
