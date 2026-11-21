/**
 * The desktop app's UI preferences (#c7fzzxk8). The desktop window loads the
 * app from a random port, so its origin and `localStorage` change on every
 * launch; the app mirrors its `gumply:*` keys here instead, and the desktop
 * shell keeps them in its settings (userData, never the vault).
 * `GET/PUT /api/ui/state` exist only when the desktop app starts the server.
 */
import { badRequest } from "./errors.js";

/** All entries together (keys + values, in UTF-16 units). */
export const UI_STATE_LIMIT = 256 * 1024;
/** One value. */
export const UI_STATE_VALUE_LIMIT = 64 * 1024;

export type UiState = Record<string, string>;

export interface UiStateChange {
  set?: Record<string, string>;
  remove?: string[];
}

/** Where the desktop shell keeps them; `update` returns the new state. */
export interface UiStateStore {
  get(): UiState;
  update(change: UiStateChange): UiState;
}

/** Only the app's own keys: `gumply:…`, printable, at most 512 characters. */
export function isUiStateKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.startsWith("gumply:") &&
    key.length > "gumply:".length &&
    key.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(key)
  );
}

/** Validate a `PUT /api/ui/state` body (400 on anything unexpected). */
export function parseUiStateChange(body: unknown): UiStateChange {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Expected { set?, remove? }");
  const { set, remove } = body as { set?: unknown; remove?: unknown };
  const change: UiStateChange = {};
  if (set !== undefined) {
    if (!set || typeof set !== "object" || Array.isArray(set)) throw badRequest("set must be an object");
    for (const [key, value] of Object.entries(set)) {
      if (!isUiStateKey(key)) throw badRequest(`Not a UI state key: ${String(key).slice(0, 40)}`);
      if (typeof value !== "string") throw badRequest("UI state values are strings");
      if (value.length > UI_STATE_VALUE_LIMIT) throw badRequest("UI state value is too large");
    }
    change.set = set as Record<string, string>;
  }
  if (remove !== undefined) {
    if (!Array.isArray(remove) || !remove.every(isUiStateKey)) throw badRequest("remove must list UI state keys");
    change.remove = remove;
  }
  return change;
}

const sizeOf = (state: UiState) =>
  Object.entries(state).reduce((total, [key, value]) => total + key.length + value.length, 0);

/**
 * The state after `change`. Newest entries last; over `limit`, the entries
 * least recently written go first (old boards' remembered views), never the
 * ones this change writes.
 */
export function applyUiStateChange(state: UiState, change: UiStateChange, limit = UI_STATE_LIMIT): UiState {
  const next = new Map(Object.entries(state).filter(([key, value]) => isUiStateKey(key) && typeof value === "string"));
  for (const key of change.remove ?? []) next.delete(key);
  const written = new Set<string>();
  for (const [key, value] of Object.entries(change.set ?? {})) {
    next.delete(key);
    next.set(key, value);
    written.add(key);
  }
  let size = sizeOf(Object.fromEntries(next));
  for (const [key, value] of next) {
    if (size <= limit) break;
    if (written.has(key)) continue;
    next.delete(key);
    size -= key.length + value.length;
  }
  return Object.fromEntries(next);
}

/** A normalised copy of stored state (a damaged settings file never breaks the app). */
export function normaliseUiState(raw: unknown): UiState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      isUiStateKey(entry[0]) && typeof entry[1] === "string" && entry[1].length <= UI_STATE_VALUE_LIMIT,
  );
  return applyUiStateChange(Object.fromEntries(entries), {});
}
