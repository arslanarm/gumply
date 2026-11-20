/**
 * Pure helpers for the Cmd/Ctrl+K quick switcher (D13, spec/ux §10).
 */
import type { PageMeta, SearchResult } from "@gumply/core";
import { folderPath } from "./wikilinks.js";

export const MAX_SEARCH_ROWS = 8;
export const RECENT_LIMIT = 5;

export interface SearchRow {
  kind: "page" | "text" | "create";
  /** Stable key: the page id, or `create` for the create row. */
  key: string;
  page?: PageMeta;
  /** Primary text (page title, or `Create “X”`). */
  label: string;
  /** Folder path shown when two pages share a title. */
  path?: string;
  /** Body context for text matches. */
  snippet?: string;
  /** Title to create for the create row. */
  title?: string;
}

export interface SearchSections {
  pages: SearchRow[];
  text: SearchRow[];
  create: SearchRow | null;
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

function toRow(
  page: PageMeta,
  counts: Map<string, number>,
  kind: "page" | "text",
  snippet?: string,
): SearchRow {
  const duplicate = (counts.get(normalise(page.title)) ?? 0) > 1;
  const path = duplicate ? folderPath(page) : "";
  return {
    kind,
    key: page.id,
    page,
    label: page.title,
    ...(path.length > 0 ? { path } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

/** The five most recently updated pages (spec/ux §3 “Recent”). */
export function recentPages(pages: readonly PageMeta[], limit = RECENT_LIMIT): PageMeta[] {
  return [...pages]
    .sort(
      (a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    )
    .slice(0, limit);
}

export function recentRows(pages: readonly PageMeta[]): SearchRow[] {
  const counts = titleCounts(pages);
  return recentPages(pages).map((page) => toRow(page, counts, "page"));
}

function hasExactTitle(pages: readonly PageMeta[], query: string): boolean {
  const needle = normalise(query);
  return needle.length > 0 && pages.some((page) => normalise(page.title) === needle);
}

/**
 * Split `/api/search` results into **Pages** (title matches) and **Text**
 * (body-only matches, with a snippet), capped at eight each, plus the
 * **Create “X”** row when no page has that exact title. Duplicate titles show
 * their folder path.
 */
export function searchSections(
  results: readonly SearchResult[],
  pages: readonly PageMeta[],
  query: string,
): SearchSections {
  const needle = normalise(query);
  const trimmed = query.trim();
  if (needle.length === 0) return { pages: [], text: [], create: null };

  const counts = titleCounts(pages);
  const pagesRows: SearchRow[] = [];
  const textRows: SearchRow[] = [];

  for (const result of results) {
    const title = normalise(result.page.title);
    if (title.includes(needle)) {
      if (pagesRows.length < MAX_SEARCH_ROWS) pagesRows.push(toRow(result.page, counts, "page"));
    } else if (textRows.length < MAX_SEARCH_ROWS) {
      textRows.push(toRow(result.page, counts, "text", result.snippet));
    }
  }

  const create =
    trimmed.length > 0 && !hasExactTitle(pages, trimmed)
      ? { kind: "create" as const, key: "create", label: `Create “${trimmed}”`, title: trimmed }
      : null;

  return { pages: pagesRows, text: textRows, create };
}

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a snippet so every occurrence of `query` can be highlighted. */
export function highlightSegments(text: string, query: string): SnippetPart[] {
  const needle = query.trim();
  if (needle.length === 0 || text.length === 0) return [{ text, highlight: false }];

  const parts: SnippetPart[] = [];
  const pattern = new RegExp(escapeRegExp(needle), "gi");
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), highlight: false });
    parts.push({ text: match[0], highlight: true });
    last = index + match[0].length;
  }

  if (last < text.length) parts.push({ text: text.slice(last), highlight: false });
  return parts.length > 0 ? parts : [{ text, highlight: false }];
}
