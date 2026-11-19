/**
 * Wikilink and tag extraction (D4).
 *
 * Supports `[[Title]]`, `[[Title|alias]]`, `[[Title#heading]]`. Links and tags
 * inside code spans/blocks are ignored, matching the team spec.
 */
import type { LinkEdge, PageMeta } from "./types.js";
import { slugify, titleFromId } from "./ids.js";

export interface WikiLink {
  /** Page title the link points at (without alias/heading). */
  targetTitle: string;
  alias?: string;
  heading?: string;
  /** Original `[[...]]` text. */
  raw: string;
  /** Index of the opening `[[` in the source text. */
  index: number;
}

/** Replace fenced code blocks and inline code spans with spaces. */
export function maskCode(markdown: string): string {
  return maskInlineCode(maskFencedCode(markdown));
}

function maskFencedCode(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;

  return lines
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (match && match[1]?.[0] === fence.char && (match[1]?.length ?? 0) >= fence.length) {
          fence = null;
        }
        return " ".repeat(line.length);
      }
      if (match && match[1]) {
        fence = { char: match[1][0] ?? "`", length: match[1].length };
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}

function maskInlineCode(text: string): string {
  const chars = [...text];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }

    let run = 1;
    while (text[i + run] === "`") run += 1;

    let cursor = i + run;
    let close = -1;
    while (cursor < text.length) {
      if (text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let closeRun = 1;
      while (text[cursor + closeRun] === "`") closeRun += 1;
      if (closeRun === run) {
        close = cursor;
        break;
      }
      cursor += closeRun;
    }

    if (close === -1) {
      i += run;
      continue;
    }

    for (let k = i; k < close + run; k += 1) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
    i = close + run;
  }

  return chars.join("");
}

/** Extract all wikilinks from a Markdown body, in document order. */
export function extractWikilinks(markdown: string): WikiLink[] {
  const text = maskCode(markdown);
  const links: WikiLink[] = [];
  const pattern = /\[\[([^[\]]*)\]\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const inner = match[1] ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const aliasPart = pipe === -1 ? "" : inner.slice(pipe + 1);

    const hash = targetPart.indexOf("#");
    const title = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim().replace(/\s+/g, " ");
    if (title.length === 0) continue;

    const heading = hash === -1 ? "" : targetPart.slice(hash + 1).trim();
    const alias = aliasPart.trim();

    const link: WikiLink = {
      targetTitle: title,
      raw: match[0],
      index: match.index,
    };
    if (alias.length > 0) link.alias = alias;
    if (heading.length > 0) link.heading = heading;
    links.push(link);
  }

  return links;
}

/** Extract inline `#tags`, ignoring code and Markdown headings. */
export function extractTags(markdown: string): string[] {
  const text = maskCode(markdown);
  const seen = new Set<string>();
  const tags: string[] = [];
  const pattern = /(^|[\s([{>"'])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const tag = (match[2] ?? "").replace(/[/-]+$/, "");
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

/** Convenience: both link targets and tags from one body. */
export function extractPageLinks(markdown: string): { links: WikiLink[]; tags: string[] } {
  return { links: extractWikilinks(markdown), tags: extractTags(markdown) };
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve a `[[Title]]` target against the page list: title first (exact,
 * then case-insensitive), then page id, then file name. Mirrors D4.
 */
export function resolveWikilink(targetTitle: string, pages: readonly PageMeta[]): PageMeta | null {
  const target = normalise(targetTitle);
  if (target.length === 0) return null;

  const byTitle = (candidate: PageMeta): string => normalise(candidate.title);
  const byId = (candidate: PageMeta): string => normalise(candidate.id);
  const lastSegment = (candidate: PageMeta): string => normalise(candidate.id.split("/").pop() ?? "");

  const checks: Array<(page: PageMeta) => boolean> = [
    (page) => page.title === targetTitle.trim(),
    (page) => byTitle(page) === target,
    (page) => byId(page) === target,
    (page) => lastSegment(page) === slugify(targetTitle),
    (page) => lastSegment(page) === target,
    (page) => byId(page).endsWith(`/${slugify(targetTitle)}`),
    (page) => normalise(titleFromId(page.id)) === target,
  ];

  for (const check of checks) {
    const found = pages.find(check);
    if (found) return found;
  }
  return null;
}

/**
 * Build deduplicated link edges for a page body. Links pointing back at the
 * page itself are dropped (no graph self-loops); unresolved links keep
 * `target: null`.
 */
export function collectLinkEdges(pageId: string, content: string, pages: readonly PageMeta[]): LinkEdge[] {
  const seen = new Set<string>();
  const edges: LinkEdge[] = [];

  for (const link of extractWikilinks(content)) {
    const target = resolveWikilink(link.targetTitle, pages);
    if (target?.id === pageId) continue;

    const key = `${link.targetTitle}\u0000${target?.id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({ source: pageId, target: target?.id ?? null, targetTitle: link.targetTitle });
  }

  return edges;
}

/** Short plain-text excerpt around `query`, with ellipses when truncated. */
export function makeSnippet(content: string, query: string, radius = 60): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";

  const needle = query.trim().toLowerCase();
  const at = needle.length === 0 ? -1 : flat.toLowerCase().indexOf(needle);

  if (at === -1) {
    return flat.length <= radius * 2 ? flat : `${flat.slice(0, radius * 2).trimEnd()}…`;
  }

  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  const snippet = flat.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < flat.length ? "…" : ""}`;
}
