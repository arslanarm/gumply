/**
 * Pure helpers for the Cmd/Ctrl+K quick switcher (D13, spec/ux §10).
 */
import type { PageMeta, SearchResult } from "@gumply/core";
import { folderPath, parseWikiLinkText } from "./wikilinks.js";
import { relativeTime, t } from "../i18n/index.js";

export const MAX_SEARCH_ROWS = 8;
export const RECENT_LIMIT = 5;

export interface SearchRow {
  kind: "page" | "text" | "create" | "create-board" | "from-template" | "language" | "today" | "page-template";
  /** Stable key: the page id, or `create` for the create row. */
  key: string;
  page?: PageMeta;
  /** Primary text (page title, or `Create “X”`). */
  label: string;
  /** Folder path (or edit time, same folder) shown when two pages share a title. */
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
  /** `Create whiteboard “X”`, offered next to `Create “X”` (spec/whiteboard §4). */
  createBoard: SearchRow | null;
  /** `New board from template…` when the query asks for it (spec/v0-6 §D). */
  fromTemplate: SearchRow | null;
  /** `Language…` (opens Settings) when the query asks for it (#7h5utv23). */
  language: SearchRow | null;
  /** v0.7 C: `Open today's note` ("today", "daily"…). */
  today: SearchRow | null;
  /** v0.7 C: `New page from template…` ("template", "new page from…"). */
  pageTemplate: SearchRow | null;
}

/** Words for this language's command (English always counts), from a message. */
function localWords(key: "search.todayWords" | "search.pageTemplateWords"): string[] {
  return t(key).toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `query` asks for today's daily note: "today", "daily", "journal"… (v0.7 C). */
export function wantsToday(query: string): boolean {
  const needle = normalise(query);
  if (needle.length < 3) return false;
  const words = ["today", "daily", "daily note", "journal", ...localWords("search.todayWords")];
  return words.some((word) => word.startsWith(needle));
}

/**
 * Whether `query` asks for a page template: every word starts a word of
 * "new page from template", and one of them is about templates (v0.7 C).
 */
export function wantsPageTemplate(query: string): boolean {
  const words = normalise(query).split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return false;
  const local = localWords("search.pageTemplateWords");
  const known = ["new", "page", "from", "template", "templates", ...local];
  const templateWord = ["template", "templates", ...local.filter((word) => word.startsWith("шаблон"))];
  return (
    words.every((word) => known.some((candidate) => candidate.startsWith(word))) &&
    words.some((word) => word.length >= 3 && templateWord.some((candidate) => candidate.startsWith(word)))
  );
}

/**
 * Whether `query` asks for the language setting: it starts "language",
 * "settings", "lang" or the interface language's own word(s).
 */
export function wantsLanguage(query: string): boolean {
  const needle = normalise(query);
  if (needle.length < 3) return false;
  const words = ["language", "languages", "settings", "lang", ...t("search.languageWords").toLowerCase().split(/\s+/).filter(Boolean)];
  return words.some((word) => word.startsWith(needle));
}

/** Words that offer `New board from template…`: the command and the template names. */
const TEMPLATE_WORDS = "new board from template whiteboard kanban mind map retrospective retro flowchart weekly plan".split(" ");

/** English words always count; the interface language adds its own (#7h5utv23). */
function templateWords(): string[] {
  const local = t("search.templateWords").toLowerCase().split(/\s+/).filter(Boolean);
  return local.length > 0 ? [...TEMPLATE_WORDS, ...local] : TEMPLATE_WORDS;
}

/**
 * Whether `query` asks for a board template: every word of it starts a word
 * of the command or of a template name ("templ", "new board", "kanban"…).
 */
export function wantsTemplate(query: string): boolean {
  const words = normalise(query).split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return false;
  const filler = ["new", "from", "a", ...t("search.templateFiller").toLowerCase().split(/\s+/).filter(Boolean)];
  const meaningful = words.some((word) => !filler.includes(word));
  const known = templateWords();
  return meaningful && words.every((word) => known.some((candidate) => candidate.startsWith(word)));
}

function fromTemplateRow(): SearchRow {
  return { kind: "from-template", key: "from-template", label: t("search.fromTemplate") };
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

/** "just now", "5 min ago", "3 h ago", then a short date (in the interface language). */
export { relativeTime };

function toRow(
  page: PageMeta,
  counts: Map<string, number>,
  kind: "page" | "text",
  snippet?: string,
): SearchRow {
  const duplicate = (counts.get(normalise(page.title)) ?? 0) > 1;
  // Same title in the same folder: the edit time is what tells them apart.
  const path = duplicate ? folderPath(page) || t("search.edited", { time: relativeTime(page.updated) }) : "";
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

/**
 * What a Markdown snippet reads as on the page (#smwaixfp): `[[Page|alias]]`
 * → alias, `[text](url)` → text, no `#`, `>`, list or emphasis markers, no
 * tags. Applied to body-match snippets before highlighting.
 */
export function plainTextSnippet(snippet: string): string {
  return snippet
    .replace(/!\[\[([^\]]*)\]\]/g, (_m, inner: string) => inner.split("|")[0] ?? inner)
    .replace(/\[\[([^[\]]*)\]\]/g, (match, inner: string) => {
      const parsed = parseWikiLinkText(match);
      if (!parsed) return inner;
      const label = parsed.alias.length > 0 ? parsed.alias : parsed.title;
      return parsed.heading.length > 0 ? `${label}#${parsed.heading}` : label;
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    // Snippets arrive with newlines collapsed, so block markers can sit
    // mid-text: headings and to-do boxes are unambiguous anywhere; quote and
    // list markers only at the start (`2 * 3`, `a > b` stay).
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)[-*+]\s+\[[ xX]\]\s+/g, "$1")
    .replace(/^(…\s*)?(>\s*)+/, "$1")
    .replace(/^(…\s*)?([-*+]|\d+[.)])\s+/, "$1")
    .replace(/(\*\*|__|~~|==)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ");
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
  if (needle.length === 0) {
    return { pages: [], text: [], create: null, createBoard: null, fromTemplate: null, language: null, today: null, pageTemplate: null };
  }

  const counts = titleCounts(pages);
  const pagesRows: SearchRow[] = [];
  const textRows: SearchRow[] = [];

  for (const result of results) {
    const title = normalise(result.page.title);
    if (title.includes(needle)) {
      if (pagesRows.length < MAX_SEARCH_ROWS) pagesRows.push(toRow(result.page, counts, "page"));
    } else if (textRows.length < MAX_SEARCH_ROWS) {
      textRows.push(toRow(result.page, counts, "text", plainTextSnippet(result.snippet)));
    }
  }

  const create =
    trimmed.length > 0 && !hasExactTitle(pages, trimmed)
      ? { kind: "create" as const, key: "create", label: t("search.create", { title: trimmed }), title: trimmed }
      : null;

  const createBoard = create
    ? { kind: "create-board" as const, key: "create-board", label: t("search.createBoard", { title: trimmed }), title: trimmed }
    : null;

  const fromTemplate = wantsTemplate(query) ? fromTemplateRow() : null;

  const language = wantsLanguage(query) ? { kind: "language" as const, key: "language", label: t("settings.languageCommand") } : null;

  const today = wantsToday(query) ? { kind: "today" as const, key: "today", label: t("search.today") } : null;
  const pageTemplate = wantsPageTemplate(query)
    ? { kind: "page-template" as const, key: "page-template", label: t("search.pageTemplate") }
    : null;
  return { pages: pagesRows, text: textRows, create, createBoard, fromTemplate, language, today, pageTemplate };
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
