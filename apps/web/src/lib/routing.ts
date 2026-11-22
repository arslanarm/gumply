/**
 * Hash routing for the MVP: one page at a time, no router dependency.
 *
 * Format: `#/projects/gumply` (segments URL-encoded individually so nested
 * ids stay readable). `#/` means "no page open".
 */
import { isValidPageId, type PageId } from "@gumply/core";

export function pageHash(id: PageId): string {
  const encoded = id
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `#/${encoded}`;
}

export function pageIdFromHash(hash: string): PageId | null {
  if (!hash.startsWith("#/")) return null;

  const raw = hash.slice(2);
  if (raw.length === 0) return null;

  let id: string;
  try {
    id = raw
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }

  return isValidPageId(id) ? id : null;
}

/**
 * The graph view lives at `#graph` (no slash) so it can never collide with a
 * page id — `#/graph` would be the page named "Graph".
 */
export const GRAPH_HASH = "#graph";

export function isGraphHash(hash: string): boolean {
  return hash === GRAPH_HASH;
}

/**
 * The trash (#ppag3ugh): `#trash` is the list; `#trash/<trashId>` shows a
 * trashed page read-only, and `#trash/<trashId>/<page id>` one of its
 * sub-pages. Like `#graph`, no slash after `#`, so no page id can collide.
 */
export const TRASH_HASH = "#trash";

export interface TrashRoute {
  /** null = the trash list. */
  trashId: string | null;
  /** A sub-page of the entry (null = its top page). */
  id: PageId | null;
}

export function trashHash(trashId?: string, id?: PageId | null): string {
  if (!trashId) return TRASH_HASH;
  return `${TRASH_HASH}/${encodeURIComponent(trashId)}${id ? pageHash(id).slice(1) : ""}`;
}

export function trashRouteFromHash(hash: string): TrashRoute | null {
  if (hash === TRASH_HASH) return { trashId: null, id: null };
  if (!hash.startsWith(`${TRASH_HASH}/`)) return null;
  const rest = hash.slice(TRASH_HASH.length + 1);
  const slash = rest.indexOf("/");
  const trashId = slash === -1 ? rest : rest.slice(0, slash);
  if (!/^[A-Za-z0-9-]+$/.test(trashId)) return null;
  if (slash === -1) return { trashId, id: null };
  const id = pageIdFromHash(`#${rest.slice(slash)}`);
  return id ? { trashId, id } : null;
}

/**
 * D43 (spec/sync-conflicts §4.2): the Conflicts list lives at `#conflicts`
 * (no slash, like `#graph` and `#trash`, so no page id can collide).
 */
export const CONFLICTS_HASH = "#conflicts";

export function isConflictsHash(hash: string): boolean {
  return hash === CONFLICTS_HASH;
}
