/**
 * Desktop UI preferences that survive a relaunch (#c7fzzxk8).
 *
 * The desktop window loads the app from a random port, so its origin and its
 * `localStorage` are new on every launch. In the desktop app (only there the
 * server answers `GET /api/ui/state`), the saved `gumply:*` entries are put
 * into `localStorage` before the app renders, and every later change to a
 * `gumply:*` key is mirrored back (debounced). Call sites keep using
 * `localStorage` as before; the browser is unchanged.
 */
import { registerSaver } from "./pending-saves.js";

const PREFIX = "gumply:";
const DELAY = 300;

type Fetch = typeof fetch;

/** Restore the saved preferences; resolves to whether this is the desktop app. */
export async function restoreUiState(storage: Storage = window.localStorage, fetchImpl: Fetch = fetch): Promise<boolean> {
  let state: Record<string, unknown>;
  try {
    const response = await fetchImpl("/api/ui/state", { headers: { Accept: "application/json" } });
    if (!response.ok) return false; // the browser app: no such route
    state = (await response.json()) as Record<string, unknown>;
  } catch {
    return false;
  }
  // The saved state is the truth: what this origin had before (a pinned
  // port in development) is replaced by it.
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX) && !(key in state)) storage.removeItem(key);
  }
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(PREFIX) && typeof value === "string") storage.setItem(key, value);
  }
  installUiStateMirror(storage, fetchImpl);
  return true;
}

/** Mirror later `gumply:*` writes to the server. Returns the uninstall. */
export function installUiStateMirror(storage: Storage, fetchImpl: Fetch = fetch): () => void {
  const pending = new Map<string, string | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const body = () => {
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const [key, value] of pending) {
      if (value === null) remove.push(key);
      else set[key] = value;
    }
    pending.clear();
    return JSON.stringify({ set, remove });
  };
  const send = (keepalive = false): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return inFlight ?? Promise.resolve();
    const request = fetchImpl("/api/ui/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body(),
      ...(keepalive ? { keepalive: true } : {}),
    }).then(
      () => undefined,
      () => undefined, // a lost preference is never worth an error banner
    );
    const tracked: Promise<void> = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
  const queue = (key: string, value: string | null) => {
    pending.set(key, value);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void send(), DELAY);
  };

  const proto = Object.getPrototypeOf(storage) as Storage;
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;
  proto.setItem = function setItem(this: Storage, key: string, value: string) {
    originalSet.call(this, key, value);
    if (this === storage && String(key).startsWith(PREFIX)) queue(String(key), String(value));
  };
  proto.removeItem = function removeItem(this: Storage, key: string) {
    originalRemove.call(this, key);
    if (this === storage && String(key).startsWith(PREFIX)) queue(String(key), null);
  };

  // Quit, close and vault switch flush this too (`__gumplyFlush`, #3t6v62cb).
  const unregister = registerSaver({
    isDirty: () => pending.size > 0 || inFlight !== null,
    hasFailed: () => false,
    flush: () => send(),
    flushOnExit: () => {
      void send(true);
      return true;
    },
  });
  return () => {
    proto.setItem = originalSet;
    proto.removeItem = originalRemove;
    unregister();
  };
}
