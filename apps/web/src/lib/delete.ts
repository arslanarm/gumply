/**
 * Pure delete-flow helpers: sub-page counts, dialog copy and where focus
 * should land afterwards (D11/D15).
 */
import type { PageId, PageMeta } from "@gumply/core";
import { comparePages } from "./tree.js";

/** Direct sub-pages of `id` (what the delete dialog counts). */
export function directSubPages(pages: readonly PageMeta[], id: PageId): PageMeta[] {
  return pages.filter((page) => page.parentId === id);
}

/** `id` plus every page beneath it, parents before children. */
export function subtreePages(pages: readonly PageMeta[], id: PageId): PageMeta[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const root = byId.get(id);
  if (!root) return [];

  const out: PageMeta[] = [root];
  const queue: PageId[] = [id];
  const seen = new Set<PageId>([id]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const page of pages) {
      if (page.parentId !== current || seen.has(page.id)) continue;
      seen.add(page.id);
      out.push(page);
      queue.push(page.id);
    }
  }

  return out;
}

/** D33: what deleting a folder also deletes (pages and boards inside, at any depth). */
export function pagesInside(pages: readonly PageMeta[], id: PageId): number {
  return subtreePages(pages, id).filter((page) => page.id !== id && page.kind !== "folder").length;
}

/** D15 copy; a folder (D33) counts the pages inside instead of sub-pages. */
export function deleteDialogBody(subPages: number, folder = false): string {
  if (folder) {
    return subPages === 1 ? "The 1 page inside will be deleted too." : `The ${subPages} pages inside will be deleted too.`;
  }
  return subPages === 1
    ? "Its 1 sub-page will be deleted too."
    : `Its ${subPages} sub-pages will be deleted too.`;
}

/**
 * Sibling to focus after deleting `id`: next sibling, else previous, else
 * `null` (the caller focuses the New page button). Siblings follow tree order.
 */
export function focusAfterDelete(pages: readonly PageMeta[], id: PageId): PageId | null {
  const deleted = pages.find((page) => page.id === id);
  if (!deleted) return null;

  const siblings = pages
    .filter((page) => page.parentId === deleted.parentId)
    .sort(comparePages);
  const index = siblings.findIndex((page) => page.id === id);
  if (index === -1) return null;

  const next = siblings[index + 1] ?? siblings[index - 1];
  return next?.id ?? null;
}
