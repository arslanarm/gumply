/**
 * Pure helpers for the `[[` autocomplete (D4, spec/ux §8).
 */
import type { Attachment, PageId, PageMeta } from "@gumply/core";
import { isBoard } from "./boards.js";
import { t } from "../i18n/index.js";

export interface LinkSuggestion {
  kind: "page" | "attachment" | "create";
  /** Stable key: page id, or `create` for the create row. */
  key: string;
  /** Text shown in the menu (folder path when titles collide). */
  label: string;
  /** Page emoji, when set. */
  icon?: string;
  /** Title written into the `[[...]]` node. */
  title: string;
  pageId?: PageId;
  /** The page is a whiteboard (shown with the board icon). */
  board?: boolean;
  /** File/image row from `vault/attachments/`. */
  attachment?: Attachment;
  /** `![[Page#…]]` (#5dpxwac4): a heading's text or `^blockid`. */
  part?: string;
  /** Indent of a heading row in the `![[Page#` menu (its level). */
  level?: number;
}

const MAX_PAGES = 8;
const MAX_ATTACHMENTS = 8;

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Folder segments of a page id, capitalised for display (e.g. `Projects/Plan` → `Projects`). */
export function folderPath(page: PageMeta): string {
  return page.id
    .split("/")
    .slice(0, -1)
    .map((segment) => {
      const words = segment.replace(/[-_]+/g, " ").trim();
      return words.length === 0 ? segment : words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join("/");
}

/** Title prefixed with its folder path, used when titles collide. */
export function folderLabel(page: PageMeta): string {
  const folders = folderPath(page);
  return folders.length === 0 ? page.title : `${folders}/${page.title}`;
}

/**
 * Pages matching `query` (title, case-insensitive) plus a **Create “X”** row
 * when there is no exact title match. Duplicate titles show their folder path.
 */
export function buildLinkSuggestions(
  pages: readonly PageMeta[],
  query: string,
  attachments: readonly Attachment[] = [],
): LinkSuggestion[] {
  const needle = normalise(query);
  const counts = new Map<string, number>();
  for (const page of pages) {
    const key = normalise(page.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const matches = [...pages]
    .filter((page) => needle.length === 0 || normalise(page.title).includes(needle))
    .sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
    })
    .slice(0, MAX_PAGES);

  const items: LinkSuggestion[] = matches.map((page) => ({
    kind: "page",
    key: page.id,
    label: (counts.get(normalise(page.title)) ?? 0) > 1 ? folderLabel(page) : page.title,
    icon: page.icon,
    title: page.title,
    pageId: page.id,
    ...(isBoard(page) ? { board: true } : {}),
  }));

  const fileMatches = [...attachments]
    .filter((item) => needle.length === 0 || normalise(item.name).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, MAX_ATTACHMENTS)
    .map<LinkSuggestion>((attachment) => ({
      kind: "attachment",
      key: `${attachment.path}`,
      label: attachment.name,
      title: attachment.name,
      attachment,
    }));

  const exact = needle.length > 0 && pages.some((page) => normalise(page.title) === needle);
  const typed = query.trim();
  items.push(...fileMatches);
  if (typed.length > 0 && !exact) {
    items.push({
      kind: "create",
      key: "create",
      label: t("search.create", { title: typed }),
      title: typed,
    });
  }

  return items;
}

/** Read a `[[Target#Heading|alias]]` string into node attrs. */
export function parseWikiLinkText(raw: string): { title: string; alias: string; heading: string } | null {
  const match = /^\[\[([^[\]]*)\]\]$/.exec(raw.trim());
  if (!match) return null;
  const inner = match[1] ?? "";
  const pipe = inner.indexOf("|");
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  const hash = targetPart.indexOf("#");
  const title = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
  const heading = hash === -1 ? "" : targetPart.slice(hash + 1).trim();
  if (title.length === 0) return null;
  return { title, alias, heading };
}
