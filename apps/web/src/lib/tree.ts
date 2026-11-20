/**
 * Pure helpers for the sidebar: turn the flat `PageMeta[]` from
 * `GET /api/pages` into a sorted tree, and validate drag-and-drop moves.
 */
import { isBoard } from "./boards.js";
import type { PageId, PageMeta } from "@gumply/core";

export interface PageTreeNode {
  page: PageMeta;
  children: PageTreeNode[];
}

// One collator for every comparison: `localeCompare` with options builds a
// new one per call, which made sorting 1000 pages take ~100 ms on a slow CPU.
const titleCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const idCollator = new Intl.Collator();

function comparePages(a: PageMeta, b: PageMeta): number {
  const byTitle = titleCollator.compare(a.title, b.title);
  return byTitle !== 0 ? byTitle : idCollator.compare(a.id, b.id);
}

/** Sibling ordering used by both the tree and focus-after-delete. */
export { comparePages };

/** Ancestors from the root down to `id` (what the topbar breadcrumb shows). */
export function pageTrail(pages: readonly PageMeta[], id: PageId): PageMeta[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const trail: PageMeta[] = [];
  const seen = new Set<PageId>();
  let current: PageId | null = id;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const page = byId.get(current);
    if (!page) break;
    trail.unshift(page);
    current = page.parentId;
  }
  return trail;
}

/** True when `candidate` is `id` or one of its descendants. */
export function isSelfOrDescendant(id: PageId, candidate: PageId): boolean {
  return candidate === id || candidate.startsWith(`${id}/`);
}

/**
 * Build the tree from `parentId` links. Pages whose parent is missing (or
 * whose parent chain loops) become roots instead of disappearing.
 */
export function buildPageTree(pages: readonly PageMeta[]): PageTreeNode[] {
  const sorted = [...pages].sort(comparePages);
  const nodes = new Map<PageId, PageTreeNode>();
  for (const page of sorted) nodes.set(page.id, { page, children: [] });

  const roots: PageTreeNode[] = [];

  for (const page of sorted) {
    const node = nodes.get(page.id);
    if (!node) continue;

    const parent = page.parentId ? nodes.get(page.parentId) : undefined;
    if (parent && !wouldCycle(page.id, parent.page.id, nodes)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function wouldCycle(id: PageId, parentId: PageId, nodes: Map<PageId, PageTreeNode>): boolean {
  let current: PageId | null = parentId;
  const seen = new Set<PageId>();

  while (current) {
    if (current === id) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = nodes.get(current)?.page.parentId ?? null;
  }

  return false;
}

/**
 * Guard a drag-and-drop move: no-op when the target is the page itself or one
 * of its descendants (the server would reject it too).
 */
export function canMovePage(
  pages: readonly PageMeta[],
  id: PageId,
  newParentId: PageId | null,
): boolean {
  if (!pages.some((page) => page.id === id)) return false;
  if (newParentId === null) return true;
  if (newParentId === id || isSelfOrDescendant(id, newParentId)) return false;
  const parent = pages.find((page) => page.id === newParentId);
  if (!parent) return false;
  // Boards have no sub-pages (spec/whiteboard §2).
  if (isBoard(parent)) return false;

  // Ids normally nest by path, but walk parentId links as well so imported
  // vaults with irregular ids still cannot create a cycle.
  const seen = new Set<PageId>();
  let cursor: PageId | null = newParentId;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === id) return false;
    seen.add(cursor);
    cursor = pages.find((page) => page.id === cursor)?.parentId ?? null;
  }

  return true;
}
