/**
 * Never lose the last edits when the page goes away (#3t6v62cb, D14).
 *
 * Every open editor (a page's autosave, a board's) registers a saver here.
 * - Tab hidden (`visibilitychange`): flush normally; the tab may never come back.
 * - Reload, close, navigation away (`beforeunload`, then `pagehide`): send
 *   what is pending right now with a keepalive request, which outlives the
 *   page. Only when that's impossible (too big, a conflict, a failed save) the
 *   browser asks "Leave site?".
 * - The desktop app calls `window.__gumplyFlush()` before closing a window,
 *   quitting or switching vaults; it resolves once the server confirmed (at
 *   most `timeout` ms) with whether everything is saved.
 */

export interface PendingSaver {
  /** Edits newer than the last confirmed save. */
  isDirty(): boolean;
  /** The last save failed or conflicted. */
  hasFailed(): boolean;
  /** Write now; resolves when done (failures are reported by the saver). */
  flush(): Promise<void>;
  /** Synchronous keepalive send; false when it couldn't be sent. */
  flushOnExit(): boolean;
}

const savers = new Set<PendingSaver>();

/**
 * A random id for one editor's saves (`writer` in spec/api): the server lets
 * only the editor that made its last write send the version that write
 * replaced (a save that left while that write was in flight).
 */
export function newWriterId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function registerSaver(saver: PendingSaver): () => void {
  savers.add(saver);
  return () => {
    savers.delete(saver);
  };
}

export function hasUnsavedChanges(): boolean {
  for (const saver of savers) if (saver.isDirty() || saver.hasFailed()) return true;
  return false;
}

/** Flush everything and wait (at most `timeout`). True when all is saved. */
/**
 * How long close, quit and a vault switch wait for saves to be confirmed
 * (#8zc7xkgq): a slow-but-fine save on a busy machine must not look like a
 * failure ("couldn't be saved"); a really stuck one still does.
 */
export const EXIT_FLUSH_TIMEOUT = 10_000;

export async function flushAllSaves(timeout = 3000): Promise<boolean> {
  const all = Promise.all([...savers].map((saver) => saver.flush().catch(() => undefined)));
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeout))]);
  return !hasUnsavedChanges();
}

/** Send everything pending now (page unloading). True when nothing is left unsent. */
export function flushAllOnExit(): boolean {
  let sent = true;
  for (const saver of savers) {
    if (!saver.flushOnExit() || saver.hasFailed()) sent = false;
  }
  return sent;
}

declare global {
  interface Window {
    /** For the desktop shell (no preload, D26): flush and report. */
    __gumplyFlush?: () => Promise<boolean>;
  }
}

/** Install the page-level listeners once (App mount). Returns the cleanup. */
export function installUnloadGuards(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flushAllSaves();
  };
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (flushAllOnExit()) return;
    // Something can't be saved on the way out: let the person decide.
    event.preventDefault();
    event.returnValue = "";
  };
  const onPageHide = () => {
    flushAllOnExit();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);
  window.__gumplyFlush = () => flushAllSaves(EXIT_FLUSH_TIMEOUT);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pagehide", onPageHide);
    if (window.__gumplyFlush) delete window.__gumplyFlush;
  };
}
