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

/** #vhdp68sm (N8): one window's answer to the flush, with the name it shows (its page's title). */
export interface WindowFlush {
  name: string;
  result: unknown;
}

/** Everything is saved only when every window says so (or didn't refuse). */
export function flushAllSaved(results: readonly WindowFlush[]): boolean {
  return results.every((window) => flushSaved(window.result));
}

/** The windows still holding unsaved work, by name (for the dialog), in the order asked. */
export function unsavedWindowNames(results: readonly WindowFlush[]): string[] {
  return results.filter((window) => !flushSaved(window.result)).map((window) => window.name);
}

/**
 * One line on why not everything is saved, or null when it is. With one window it reads exactly
 * as before; with several, each unsaved window is named: `"Roadmap": page still saving (…)`.
 */
export function describeFlushes(results: readonly WindowFlush[], waitMs: number): string | null {
  const unsaved = results.filter((window) => !flushSaved(window.result));
  if (unsaved.length === 0) return null;
  if (results.length === 1) return describeFlush(unsaved[0]!.result, waitMs);
  return unsaved.map((window) => `"${window.name}": ${describeFlush(window.result, waitMs)}`).join("; ");
}
