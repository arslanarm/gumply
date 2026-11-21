/**
 * Whiteboards in the app (spec/whiteboard §2, spec/api v1.7, D25).
 *
 * A board's id keeps its extension (`Projects/Map.canvas`); pages never end
 * in `.canvas` (the server renames a page titled `Plan.canvas` to
 * `Plan.canvas 2`). So the id alone says what to open, even before the page
 * list has loaded (a deep link).
 */
import type { PageId, PageMeta } from "@gumply/core";
import { t } from "../i18n/index.js";

export const BOARD_EXTENSION = ".canvas";
/** "Untitled whiteboard" in the interface language (#7h5utv23). */
export function newBoardTitle(): string {
  return t("defaults.untitledBoard");
}

export function isBoardId(id: PageId | null | undefined): boolean {
  return typeof id === "string" && id.toLowerCase().endsWith(BOARD_EXTENSION);
}

export function isBoard(page: Pick<PageMeta, "id" | "kind"> | null | undefined): boolean {
  if (!page) return false;
  return page.kind === "whiteboard" || isBoardId(page.id);
}

/** The vault file of a page or board (what a board card stores). */
export function vaultPathOf(page: Pick<PageMeta, "id" | "kind">): string {
  return isBoard(page) ? page.id : `${page.id}.md`;
}

/** The page/board id a vault path points at, or null for other files. */
export function idFromVaultPath(path: string): PageId | null {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/\.md$/i.test(clean)) return clean.slice(0, -3);
  if (isBoardId(clean)) return clean;
  return null;
}

/**
 * The `[[target|alias]]` Gumply writes to link a board: the file name with
 * its extension (so Obsidian resolves it) and the title as alias.
 */
export function boardLinkParts(board: Pick<PageMeta, "id" | "title">): { target: string; alias: string } {
  const file = board.id.split("/").pop() ?? board.id;
  return { target: file, alias: board.title };
}
