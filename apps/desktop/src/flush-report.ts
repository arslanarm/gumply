/**
 * What the page answered when asked to save before closing, quitting or
 * switching vaults (#ms44vnit), and why the "couldn't be saved" dialog
 * shows. The page's `window.__gumplyFlush()` resolves with a report (or a
 * bare boolean from older pages and tests); the main process gives up on
 * waiting after its own limit.
 */

export interface PageFlushReport {
  saved: boolean;
  ms: number;
  timedOut: boolean;
  unsaved: Array<{ kind: string; dirty: boolean; failed: boolean }>;
}

/** The main process stopped waiting for the page. */
export const NO_ANSWER = Symbol("no answer");

function isReport(value: unknown): value is PageFlushReport {
  return typeof value === "object" && value !== null && typeof (value as { saved?: unknown }).saved === "boolean";
}

/** Whether everything is saved. Anything but a clear "not saved" counts as saved (as before). */
export function flushSaved(result: unknown): boolean {
  if (result === NO_ANSWER || result === false) return false;
  return isReport(result) ? result.saved : true;
}

/** One line on why it isn't saved, or null when it is. */
export function describeFlush(result: unknown, waitMs: number): string | null {
  if (flushSaved(result)) return null;
  if (result === NO_ANSWER) return `the page didn't answer within ${(waitMs / 1000).toFixed(0)} s`;
  if (!isReport(result)) return "the page reported unsaved changes (no details)";
  const savers = result.unsaved.map((saver) => `${saver.kind} ${saver.failed ? "failed" : "still saving"}`);
  const took = `${(result.ms / 1000).toFixed(1)} s${result.timedOut ? ", timed out" : ""}`;
  return `${savers.length > 0 ? savers.join(", ") : "unsaved changes"} (flush took ${took})`;
}
