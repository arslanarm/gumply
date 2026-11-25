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
import { extractWikilinks, formatBoardEmbed, formatPageEmbed, isBoardTarget, type WikiLink } from "./links.js";
import type { PageMeta } from "./types.js";

/** A page's file name without `.md` (the last segment of its id, D20). */
export function pageBasename(page: Pick<PageMeta, "id">): string {
  return page.id.split("/").filter(Boolean).pop() ?? page.id;
}

function same(a: string, b: string): boolean {
  const key = (value: string) => value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  return key(a) === key(b);
}

/**
 * #siuwzhwy: a title as a link alias. `[` and `]` can't appear inside `[[…]]` (a `]`
 * ends the link early, so `[[draft|[draft]]]` wasn't a link at all); they're dropped
 * from the alias. The page keeps its title; only the link's shown text loses them.
 */
function aliasFor(title: string): string {
  return title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
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
  // `[[Plan|Plan]]` is just noise: an alias equal to the target is dropped.
  const alias = aliasFor(page.title);
  return { target, alias: alias === target || alias.length === 0 ? "" : alias };
}

/** #siuwzhwy: whether the line holding `index` is a Markdown table row (starts with `|`). */
function inTableRow(markdown: string, index: number): boolean {
  const start = markdown.lastIndexOf("\n", index - 1) + 1;
  return markdown.slice(start, index).trimStart().startsWith("|");
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
 * #im3em6tq: a rename rewrites links in every page that has one (1,982 for a
 * big vault's hub), always to the same page against the same list, and
 * `linkTargetFor` scans the whole list (10k pages) each time. So the rewrite
 * computes it once per list: keyed by the list object (each rename passes one
 * fresh list), then by the page's id and title.
 */
const rewriteTargets = new WeakMap<readonly PageMeta[], Map<string, LinkTarget>>();
function rewriteTargetFor(page: PageMeta, pages: readonly PageMeta[]): LinkTarget {
  let byPage = rewriteTargets.get(pages);
  if (!byPage) rewriteTargets.set(pages, (byPage = new Map()));
  const key = `${page.id}\u0000${page.title}`;
  let found = byPage.get(key);
  if (!found) byPage.set(key, (found = linkTargetFor(page, pages)));
  return found;
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
  const { target, alias: autoAlias } = rewriteTargetFor(page, pages);
  let content = markdown;
  for (const link of [...links].reverse()) {
    // #5dpxwac4: a page preview keeps its `!`, `#Heading`/`#^block` and alias.
    if (link.embed && !isBoardTarget(link.targetTitle)) {
      const replacement = formatPageEmbed(target, link.heading, link.alias);
      content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
      continue;
    }
    // D30: a board embed has no alias; it keeps its `!` and height.
    if (link.embed) {
      const replacement = formatBoardEmbed(target, link.size);
      content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
      continue;
    }
    const userAlias = link.alias && !same(link.alias, oldTitle) && !same(link.alias, page.title) ? link.alias : "";
    const shown = userAlias && userAlias !== target ? userAlias : autoAlias;
    const heading = link.heading ? `#${link.heading}` : "";
    // #siuwzhwy: in a Markdown table a bare `|` would split the cell, so the alias pipe
    // is `\|` there (kept as written, or for a link that gains an alias in a table row).
    const separator = link.escapedPipe || inTableRow(content, link.index) ? "\\|" : "|";
    const replacement = `[[${target}${heading}${shown ? `${separator}${shown}` : ""}]]`;
    content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
  }
  return { content, count: links.length };
}
