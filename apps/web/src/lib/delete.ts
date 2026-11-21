/**
 * Pure delete-flow helpers: sub-page counts, dialog copy and where focus
 * should land afterwards (D11/D15).
 */
import type { PageId, PageMeta } from "@gumply/core";
import { comparePages } from "./tree.js";
import { listJoin, t } from "../i18n/index.js";

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

/** D33 confirm copy: "Its 3 pages, 1 board and 5 other files will be moved to the trash." */
export function folderDeleteBody({ pages, boards, otherFiles }: FolderContents): string {
  const parts = [
    pages > 0 ? t("counts.pages", { count: pages }) : null,
    boards > 0 ? t("counts.boards", { count: boards }) : null,
    otherFiles > 0 ? t("counts.otherFiles", { count: otherFiles }) : null,
  ].filter((part): part is string => part !== null);
  return t("delete.folderBody", { list: listJoin(parts) });
}

/** D15 copy. */
export function deleteDialogBody(subPages: number): string {
  return t("delete.subPages", { count: subPages });
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
