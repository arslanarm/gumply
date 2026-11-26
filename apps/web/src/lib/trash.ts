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

/** Pages and boards in the trash, sub-pages and a database's rows included. */
export function trashedCount(items: readonly TrashItem[]): number {
  // A group of rows an undo took out counts its rows only (the folder itself isn't in the Trash).
  return items.reduce((total, item) => total + (item.undoRows !== undefined ? item.children.length : 1 + item.children.length + (item.rows ?? 0)), 0);
}

/** The title a Trash item shows: its own, or "2 rows from People" for the rows a table undo took out. */
export function trashTitle(item: TrashItem): string {
  return item.undoRows !== undefined ? t("trash.undoRows", { count: item.undoRows, name: item.title }) : item.title;
}

/** "Projects", or "Projects (no longer there)"; "" at the top level. */
export function trashLocation(item: TrashItem): string {
  if (item.originalParentId === null) return "";
  if (item.originalParentTitle !== null) return item.originalParentTitle;
  return item.originalParentId.split("/").pop() ?? item.originalParentId;
}

/** Body of the "Delete forever" confirmation; its version history goes too (D41). */
export function deleteForeverBody(item: TrashItem): string {
  return `${deleteForeverWhat(item)} ${t("history.deletedToo")}`;
}

function deleteForeverWhat(item: TrashItem): string {
  // #7prbquxu phase 4: the rows a table undo took out (their folder stays).
  if (item.undoRows !== undefined) return t("trash.forever.undoRows", { count: item.undoRows, name: item.title });
  // #7prbquxu phase 4a (note c): a database deleted with its rows folder takes them along.
  if (item.kind === "base" && item.rows !== undefined) {
    const parts = [t("counts.rows", { count: item.rows })];
    if (item.otherFiles) parts.push(t("counts.otherFiles", { count: item.otherFiles }));
    return t("trash.forever.database", { contents: listJoin(parts) });
  }
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
  return `${t("trash.emptyBody", { count: trashedCount(items) })} ${t("history.deletedToo")}`;
}

/** The toast after a restore: where it went, and why if it isn't where it was. */
export function restoredMessage(item: TrashItem, result: RestoreResult): string {
  const name = result.id.split("/").pop() ?? result.id;
  const shown = item.kind === "whiteboard" ? name.replace(/\.canvas$/i, "") : item.kind === "base" ? name.replace(/\.base$/i, "") : name;
  const vars = { title: trashTitle(item), name: shown, location: trashLocation(item) };
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
