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
