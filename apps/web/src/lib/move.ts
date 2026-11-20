/**
 * Pure helpers for the sidebar “Move to…” picker (spec/ux §6).
 */
import type { PageId, PageMeta } from "@gumply/core";
import { canMovePage, comparePages } from "./tree.js";
import { folderPath } from "./wikilinks.js";

export interface MoveTarget {
  kind: "top" | "page";
  /** Stable key: `top-level`, or the target page id. */
  key: string;
  label: string;
  page?: PageMeta;
  /** Folder path shown when two targets share a title. */
  path?: string;
  /** New parent for this row (`null` = top level). */
  parentId: PageId | null;
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function titleCounts(pages: readonly PageMeta[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const key = normalise(page.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Rows for moving `id`: **Top level** first (when the page is nested), then
 * every possible parent by title. The page itself and its descendants are
 * excluded (`canMovePage`), as is its current parent (a no-op).
 */
export function moveTargets(
  pages: readonly PageMeta[],
  id: PageId,
  query: string,
): MoveTarget[] {
  const page = pages.find((item) => item.id === id);
  if (!page) return [];

  const rows: MoveTarget[] = [];
  if (page.parentId !== null) {
    rows.push({ kind: "top", key: "top-level", label: "Top level", parentId: null });
  }

  const needle = normalise(query);
  const counts = titleCounts(pages);
  const targets = [...pages]
    .filter((candidate) => {
      if (candidate.id === page.parentId) return false;
      if (!canMovePage(pages, id, candidate.id)) return false;
      return needle.length === 0 || normalise(candidate.title).includes(needle);
    })
    .sort(comparePages);

  for (const target of targets) {
    const duplicate = (counts.get(normalise(target.title)) ?? 0) > 1;
    const path = duplicate ? folderPath(target) : "";
    rows.push({
      kind: "page",
      key: target.id,
      label: target.title,
      page: target,
      ...(path.length > 0 ? { path } : {}),
      parentId: target.id,
    });
  }

  return rows;
}

/** Toast copy for a completed move (spec/ux §4). */
export function moveToastMessage(
  pages: readonly PageMeta[],
  parentId: PageId | null,
): string {
  if (parentId === null) return "Moved to top level";
  const parent = pages.find((page) => page.id === parentId);
  return parent ? `Moved to “${parent.title}”` : "Page moved";
}
