/**
 * Database views in the app (D34, spec/api-bases). A base's id keeps its
 * `.base` extension, like a board's `.canvas`, so the id alone says what to
 * open, even before the page list has loaded.
 */
import type { PageId, PageMeta } from "@gumply/core";
import { t } from "../i18n/index.js";
import { isBoard } from "./boards.js";

export const BASE_EXTENSION = ".base";

export function isBaseId(id: PageId | null | undefined): boolean {
  return typeof id === "string" && id.toLowerCase().endsWith(BASE_EXTENSION);
}

export function isBase(page: Pick<PageMeta, "id" | "kind"> | null | undefined): boolean {
  if (!page) return false;
  return page.kind === "base" || isBaseId(page.id);
}

/** Boards and bases have no sub-pages and no Markdown body. */
export function isLeafItem(page: Pick<PageMeta, "id" | "kind"> | null | undefined): boolean {
  return isBoard(page) || isBase(page);
}

/** "Untitled database" in the interface language. */
export function newBaseTitle(): string {
  return t("bases.untitled");
}
