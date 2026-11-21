/**
 * Trash view helpers (#ppag3ugh): filtering, counts and what to tell the user
 * after a restore. Pure, unit-tested.
 */
import type { PageId, RestoreResult, TrashItem } from "@gumply/core";
import { listJoin, t } from "../i18n/index.js";

const normalise = (text: string) => text.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").trim();

/** Entries whose title, or a sub-page's title, contains the query. */
export function filterTrash(items: readonly TrashItem[], query: string): TrashItem[] {
  const wanted = normalise(query);
  if (!wanted) return [...items];
  return items.filter(
    (item) => normalise(item.title).includes(wanted) || item.children.some((child) => normalise(child.title).includes(wanted)),
  );
}

/** Pages and boards in the trash, sub-pages included. */
export function trashedCount(items: readonly TrashItem[]): number {
  return items.reduce((total, item) => total + 1 + item.children.length, 0);
}

/** "Projects", or "Projects (no longer there)"; "" at the top level. */
export function trashLocation(item: TrashItem): string {
  if (item.originalParentId === null) return "";
  if (item.originalParentTitle !== null) return item.originalParentTitle;
  return item.originalParentId.split("/").pop() ?? item.originalParentId;
}

/** Body of the "Delete forever" confirmation. */
export function deleteForeverBody(item: TrashItem): string {
  if (item.kind === "folder") {
    const parts = [t("counts.pagesOrBoards", { count: item.children.length })];
    if (item.otherFiles) parts.push(t("counts.otherFiles", { count: item.otherFiles }));
    return t("trash.forever.folder", { contents: listJoin(parts) });
  }
  const board = item.kind === "whiteboard";
  if (item.children.length === 0) return t(board ? "trash.forever.board" : "trash.forever.page");
  return t(board ? "trash.forever.boardWithSubPages" : "trash.forever.pageWithSubPages", { count: item.children.length });
}

/** Body of the "Empty trash" confirmation. */
export function emptyTrashBody(items: readonly TrashItem[]): string {
  return t("trash.emptyBody", { count: trashedCount(items) });
}

/** The toast after a restore: where it went, and why if it isn't where it was. */
export function restoredMessage(item: TrashItem, result: RestoreResult): string {
  const name = result.id.split("/").pop() ?? result.id;
  const shown = item.kind === "whiteboard" ? name.replace(/\.canvas$/i, "") : name;
  const vars = { title: item.title, name: shown, location: trashLocation(item) };
  if (result.movedToTopLevel && result.renamed) return t("trash.restored.toTopAs", vars);
  if (result.movedToTopLevel) return t("trash.restored.toTop", vars);
  if (result.renamed) return t("trash.restored.as", vars);
  return t("trash.restored.plain", vars);
}

/** Where a page of a restored entry is now (`id` as it was in the trash). */
export function restoredId(item: TrashItem, result: RestoreResult, id: PageId): PageId {
  if (id === item.id || id.startsWith(`${item.id}/`)) return `${result.id}${id.slice(item.id.length)}`;
  return id;
}

/** Depth of a sub-page under the entry's top page (1 = a direct child). */
export function trashDepth(item: TrashItem, id: PageId): number {
  if (id === item.id) return 0;
  return id.slice(item.id.length + 1).split("/").length;
}
