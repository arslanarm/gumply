/**
 * Wiki links that resolve in Gumply *and* in Obsidian (#mp8eadhk).
 *
 * Obsidian resolves `[[…]]` by file name; Gumply by title first (D4). They
 * agree as long as a page's title equals its file name, the common case. When
 * they differ — characters D20 strips from file names (`Ideas: Q3?` →
 * `Ideas Q3.md`), a collision suffix (`Plan 2.md`), or a legacy slug — the
 * link is written as file-name target + title alias: `[[Ideas Q3|Ideas: Q3?]]`.
 * Readers see the same text; both apps resolve it.
 */
import { extractWikilinks, type WikiLink } from "./links.js";
import type { PageMeta } from "./types.js";

/** A page's file name without `.md` (the last segment of its id, D20). */
export function pageBasename(page: Pick<PageMeta, "id">): string {
  return page.id.split("/").filter(Boolean).pop() ?? page.id;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface LinkTarget {
  /** What goes before `|`: the title, the file name, or the full path. */
  target: string;
  /** The title as alias when the target isn't the title, else "". */
  alias: string;
}

/** The `[[target|alias]]` parts for linking to `page`. */
export function linkTargetFor(page: PageMeta, pages: readonly PageMeta[]): LinkTarget {
  const others = pages.filter((other) => other.id !== page.id);
  const base = pageBasename(page);
  const titleShared = others.some((other) => same(other.title, page.title));

  if (base === page.title && !titleShared) return { target: page.title, alias: "" };

  // The file name must point at this page only, in both apps: no other page
  // may use it as its file name (Obsidian) or its title (Gumply, title first).
  const baseShared = others.some((other) => same(pageBasename(other), base) || same(other.title, base));
  const target = baseShared ? page.id : base;
  return { target, alias: page.title };
}

/** The Markdown for a link to `page` (keeping an explicit alias and heading). */
export function formatWikilink(
  page: PageMeta,
  pages: readonly PageMeta[],
  options: { alias?: string; heading?: string } = {},
): string {
  const { target, alias } = linkTargetFor(page, pages);
  const shown = options.alias || alias;
  return `[[${target}${options.heading ? `#${options.heading}` : ""}${shown ? `|${shown}` : ""}]]`;
}

/**
 * D12/D20 rename: rewrite links that resolve to the renamed page (`isTarget`)
 * to its new link form. A user alias is kept; an alias that only repeated the
 * old title is replaced (or dropped when title and file name agree again).
 */
export function rewriteLinksToPage(
  markdown: string,
  isTarget: (link: WikiLink) => boolean,
  page: PageMeta,
  pages: readonly PageMeta[],
  oldTitle: string,
): { content: string; count: number } {
  const links = extractWikilinks(markdown).filter(isTarget);
  if (links.length === 0) return { content: markdown, count: 0 };
  const { target, alias: autoAlias } = linkTargetFor(page, pages);
  let content = markdown;
  for (const link of [...links].reverse()) {
    const userAlias = link.alias && !same(link.alias, oldTitle) && !same(link.alias, page.title) ? link.alias : "";
    const shown = userAlias || autoAlias;
    const heading = link.heading ? `#${link.heading}` : "";
    const replacement = `[[${target}${heading}${shown ? `|${shown}` : ""}]]`;
    content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
  }
  return { content, count: links.length };
}
