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

/** D33: what a folder holds at any depth (pages, boards, other files such as PDFs). */
export interface FolderContents {
  pages: number;
  boards: number;
  otherFiles: number;
}

export function folderContents(pages: readonly PageMeta[], id: PageId): FolderContents {
  const inside = subtreePages(pages, id).filter((page) => page.id !== id && page.kind !== "folder");
  const boards = inside.filter((page) => page.kind === "whiteboard").length;
  const otherFiles = pages.find((page) => page.id === id)?.otherFiles ?? 0;
  return { pages: inside.length - boards, boards, otherFiles };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** D33 confirm copy: "Its 3 pages, 1 board and 5 other files will be moved to the trash." */
export function folderDeleteBody({ pages, boards, otherFiles }: FolderContents): string {
  const parts = [
    pages > 0 ? count(pages, "page", "pages") : null,
    boards > 0 ? count(boards, "board", "boards") : null,
    otherFiles > 0 ? count(otherFiles, "other file", "other files") : null,
  ].filter((part): part is string => part !== null);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
  return `Its ${list} will be moved to the trash.`;
}

/** D15 copy. */
export function deleteDialogBody(subPages: number): string {
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
