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
  // D33: folders first, like Obsidian and every file manager.
  const aFolder = a.kind === "folder";
  if (aFolder !== (b.kind === "folder")) return aFolder ? -1 : 1;
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

/** The rows folders owned by a database that doesn't show its rows in the sidebar. */
export function hiddenRowsFolders(pages: readonly PageMeta[]): Set<PageId> {
  const shown = new Set(pages.filter((page) => page.rowsFolder && page.showRows).map((page) => page.id));
  return new Set(pages.filter((page) => page.kind === "folder" && page.ownedBy && !shown.has(page.ownedBy)).map((page) => page.id));
}

/** The folder itself, or anything inside it. */
export function isUnderHiddenRows(id: PageId, hidden: ReadonlySet<PageId>): boolean {
  if (hidden.has(id)) return true;
  for (const folder of hidden) if (id.startsWith(`${folder}/`)) return true;
  return false;
}

/**
 * #7prbquxu (spec/database-tables §3, note e): the sidebar item to show as selected for the open page. A row in
 * a rows folder the sidebar hides isn't in the tree, so its database stands for it; anything else is itself.
 */
export function sidebarSelection(pages: readonly PageMeta[], selectedId: PageId | null): PageId | null {
  if (selectedId === null) return null;
  const hidden = hiddenRowsFolders(pages);
  if (hidden.size === 0 || !isUnderHiddenRows(selectedId, hidden)) return selectedId;
  for (const folder of hidden) {
    if (selectedId === folder || selectedId.startsWith(`${folder}/`)) {
      return pages.find((page) => page.id === folder)?.ownedBy ?? selectedId;
    }
  }
  return selectedId;
}

/**
 * Build the tree from `parentId` links. Pages whose parent is missing (or
 * whose parent chain loops) become roots instead of disappearing.
 */
export function buildPageTree(pages: readonly PageMeta[]): PageTreeNode[] {
  // D43: a sync conflict copy beside its page isn't in the tree; the page's
  // badge and the Conflicts list lead to it. An orphan copy (null) stays.
  // #7prbquxu phase 4 (spec/database-tables §3): a database's own rows folder isn't in the tree, and
  // nothing under it is, unless the database asks to show its rows; the database item stands for it.
  const hidden = hiddenRowsFolders(pages);
  const sorted = pages
    .filter((page) => typeof page.conflictOf !== "string" && !isUnderHiddenRows(page.id, hidden))
    .sort(comparePages);
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

/**
 * #8gudbajp: keep the node objects of everything that didn't change since the last build, so the
 * sidebar rows (memoised by their node) don't all render again when one page changes. A node is
 * kept when its page has the same data and its children are the very same nodes; otherwise it is
 * new (and so are its ancestors). `previous` maps ids to the last build's nodes.
 */
export function shareTree(
  next: readonly PageTreeNode[],
  previous: ReadonlyMap<PageId, PageTreeNode>,
): { roots: PageTreeNode[]; nodes: Map<PageId, PageTreeNode> } {
  const nodes = new Map<PageId, PageTreeNode>();
  const share = (node: PageTreeNode): PageTreeNode => {
    const children = node.children.map(share);
    const before = previous.get(node.page.id);
    const same =
      before !== undefined &&
      before.children.length === children.length &&
      before.children.every((child, index) => child === children[index]) &&
      JSON.stringify(before.page) === JSON.stringify(node.page);
    const kept = same ? before : { page: node.page, children };
    nodes.set(kept.page.id, kept);
    return kept;
  };
  return { roots: next.map(share), nodes };
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
  // Boards and database views have no sub-pages (spec/whiteboard §2, D34).
  if (isBoard(parent) || parent.kind === "base") return false;

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
