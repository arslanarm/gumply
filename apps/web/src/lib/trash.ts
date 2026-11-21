/**
 * Trash view helpers (#ppag3ugh): filtering, counts and what to tell the user
 * after a restore. Pure, unit-tested.
 */
import type { PageId, RestoreResult, TrashItem } from "@gumply/core";

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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Projects", or "Projects (no longer there)"; "" at the top level. */
export function trashLocation(item: TrashItem): string {
  if (item.originalParentId === null) return "";
  if (item.originalParentTitle !== null) return item.originalParentTitle;
  return item.originalParentId.split("/").pop() ?? item.originalParentId;
}

/** Body of the "Delete forever" confirmation. */
export function deleteForeverBody(item: TrashItem): string {
  if (item.kind === "folder") {
    const parts = [plural(item.children.length, "page or whiteboard", "pages and whiteboards")];
    if (item.otherFiles) parts.push(plural(item.otherFiles, "other file", "other files"));
    return `This deletes this folder with its ${parts.join(" and ")} from your vault for good. You can't undo this.`;
  }
  const what = item.kind === "whiteboard" ? "this whiteboard" : "this page";
  const subPages = item.children.length > 0 ? ` and ${plural(item.children.length, "sub-page", "sub-pages")}` : "";
  return `This deletes ${what}${subPages} from your vault for good. You can't undo this.`;
}

/** Body of the "Empty trash" confirmation. */
export function emptyTrashBody(items: readonly TrashItem[]): string {
  return `This deletes ${plural(trashedCount(items), "page or whiteboard", "pages and whiteboards")} from your vault for good. You can't undo this.`;
}

/** The toast after a restore: where it went, and why if it isn't where it was. */
export function restoredMessage(item: TrashItem, result: RestoreResult): string {
  const name = result.id.split("/").pop() ?? result.id;
  const shown = item.kind === "whiteboard" ? name.replace(/\.canvas$/i, "") : name;
  const where = result.movedToTopLevel ? " to the top level" : "";
  const as = result.renamed ? ` as “${shown}”` : "";
  const reasons: string[] = [];
  if (result.movedToTopLevel) reasons.push(`“${trashLocation(item)}” is no longer there`);
  if (result.renamed) reasons.push("that name was taken");
  return reasons.length === 0
    ? `Restored “${item.title}”.`
    : `Restored “${item.title}”${where}${as}: ${reasons.join(" and ")}.`;
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
