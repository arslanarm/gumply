/**
 * Wikilink and tag extraction (D4).
 *
 * Supports `[[Title]]`, `[[Title|alias]]`, `[[Title#heading]]`. Links and tags
 * inside code spans/blocks are ignored, matching the team spec.
 */
import type { LinkEdge, PageMeta } from "./types.js";
import { legacySlugTitle, slugify } from "./ids.js";
import { findInlineTags } from "./tags.js";

export interface WikiLink {
  /** Page title the link points at (without alias/heading). */
  targetTitle: string;
  alias?: string;
  heading?: string;
  /** Original `[[...]]` (or `![[...]]`) text. */
  raw: string;
  /** Index of the opening `[[` (or the `!` of an embed) in the source text. */
  index: number;
  /**
   * `![[Board.canvas]]`: a board embedded in a page (D30); `![[Page]]`,
   * `![[Page#Heading]]`, `![[Page#^block]]`: a page preview (#5dpxwac4). Both
   * count as links (backlinks, graph, rename). For a board, what follows `|`
   * is the embed's height, kept as written in `size` (never an alias).
   */
  embed?: true;
  size?: string;
}

/** True for a link target naming a board file (`Map.canvas`, `Projects/Map.canvas`). */
export function isBoardTarget(target: string): boolean {
  return /\.canvas$/i.test(target.trim());
}

/** True for a link target naming a database view (`Tasks.base`, spec/api-bases). */
export function isBaseTarget(target: string): boolean {
  return /\.base$/i.test(target.trim());
}

/** The Markdown for a board embed (D30): `![[Map.canvas]]` / `![[Map.canvas|480]]`. */
export function formatBoardEmbed(target: string, size?: string | number): string {
  const height = size === undefined || size === "" ? "" : `|${size}`;
  return `![[${target}${height}]]`;
}

/**
 * The Markdown for a page preview (#5dpxwac4): `![[Page]]`, `![[Page#Heading]]`,
 * `![[Page#^block]]`, with an optional `|alias` as written.
 */
export function formatPageEmbed(target: string, subpath?: string, alias?: string): string {
  return `![[${target}${subpath ? `#${subpath}` : ""}${alias ? `|${alias}` : ""}]]`;
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
      // CommonMark: a backtick fence's info string has no backticks, so
      // ```code``` on one line is an inline code span, not a fence.
      const info = match ? line.slice(match[0].length) : "";
      if (match && match[1] && !(match[1][0] === "`" && info.includes("`"))) {
        fence = { char: match[1][0] ?? "`", length: match[1].length };
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}

function maskInlineCode(text: string): string {
  // `split("")` keeps UTF-16 units (not code points) so indexes line up with
  // `text` even when the span contains emoji or other surrogate pairs.
  const chars = text.split("");
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

/** File kinds we treat as attachments (D18/D19); no code/domain extensions. */
const ATTACHMENT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "bmp",
  "ico",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "csv",
  "epub",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "zip",
  "7z",
  "tar",
  "gz",
  "rar",
]);

const FILE_EXTENSION = /\.([a-z0-9]{1,10})$/i;

/** True when a name ends in an allowlisted attachment extension. */
export function hasAttachmentExtension(name: string): boolean {
  const match = FILE_EXTENSION.exec(name.trim());
  return match ? ATTACHMENT_EXTENSIONS.has((match[1] ?? "").toLowerCase()) : false;
}

function isAttachmentFileTarget(title: string): boolean {
  return hasAttachmentExtension(title);
}

/** Extract all page wikilinks from a Markdown body, in document order. */
export function extractWikilinks(markdown: string): WikiLink[] {
  const text = maskCode(markdown);
  const links: WikiLink[] = [];
  // `![[file.png]]` is an attachment embed, not a page link: parseEmbeds owns
  // it, which keeps graph/backlinks free of attachment ghosts (D19). Board
  // embeds (`![[Map.canvas]]`, D30) and page previews (`![[Page#Heading]]`,
  // #5dpxwac4) are links.
  const pattern = /(!?)\[\[([^[\]]*)\]\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const embed = match[1] === "!";
    const inner = match[2] ?? "";
    const pipe = inner.indexOf("|");
    const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const aliasPart = pipe === -1 ? "" : inner.slice(pipe + 1);

    const hash = targetPart.indexOf("#");
    const title = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim().replace(/\s+/g, " ");
    if (title.length === 0) continue;
    if (isAttachmentFileTarget(title)) continue;

    const heading = hash === -1 ? "" : targetPart.slice(hash + 1).trim();
    const alias = aliasPart.trim();

    const link: WikiLink = {
      targetTitle: title,
      raw: match[0],
      index: match.index,
    };
    if (embed) {
      link.embed = true;
      if (alias.length > 0) {
        if (isBoardTarget(title)) link.size = alias;
        else link.alias = alias;
      }
    } else if (alias.length > 0) link.alias = alias;
    if (heading.length > 0) link.heading = heading;
    links.push(link);
  }

  return links;
}

/** Inline `#tags`, each once (first spelling wins); rules in `tags.ts`. */
export function extractTags(markdown: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const { tag } of findInlineTags(markdown)) {
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

export interface RewriteResult {
  content: string;
  /** Number of wikilinks that were rewritten. */
  count: number;
}

/**
 * Rewrite selected wikilink targets while keeping each link's alias and
 * heading (`[[Old|alias]]` → `[[New|alias]]`). Code spans/blocks are left
 * untouched because `extractWikilinks` ignores them.
 */
export function rewriteWikilinkTargets(
  markdown: string,
  shouldRewrite: (link: WikiLink) => boolean,
  newTitle: string,
): RewriteResult {
  const links = extractWikilinks(markdown).filter(shouldRewrite);
  if (links.length === 0) return { content: markdown, count: 0 };

  const title = newTitle.trim();
  let content = markdown;

  // Replace from the end so earlier indexes stay valid.
  for (const link of [...links].reverse()) {
    if (link.embed && !isBoardTarget(link.targetTitle)) {
      // A page preview keeps its `!`, `#Heading`/`#^block` and alias.
      const replacement = formatPageEmbed(title, link.heading, link.alias);
      content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
      continue;
    }
    if (link.embed) {
      const replacement = formatBoardEmbed(isBoardTarget(title) ? title : `${title}.canvas`, link.size);
      content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
      continue;
    }
    const inner = link.raw.slice(2, -2);
    const pipe = inner.indexOf("|");
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1);
    const beforePipe = pipe === -1 ? inner : inner.slice(0, pipe);
    const hash = beforePipe.indexOf("#");
    const heading = hash === -1 ? undefined : beforePipe.slice(hash + 1);

    const suffix = `${heading !== undefined ? `#${heading}` : ""}${alias !== undefined ? `|${alias}` : ""}`;
    const replacement = `[[${title}${suffix}]]`;
    content = content.slice(0, link.index) + replacement + content.slice(link.index + link.raw.length);
  }

  return { content, count: links.length };
}

/**
 * D33: a folder moved from `from` to `to` (vault paths, no trailing slash).
 * Rewrite path-qualified wikilinks into it (`[[Work/Ideas]]`, `|alias`,
 * `#heading`, `![[Work/Map.canvas|480]]`) to the new path. Title-only links
 * still resolve and are left alone.
 */
export function rewriteWikilinkFolder(markdown: string, from: string, to: string): RewriteResult {
  const prefix = `${from.toLowerCase()}/`;
  const moved: WikiLink[] = [];
  for (const link of extractWikilinks(markdown)) {
    if (link.targetTitle.toLowerCase().startsWith(prefix)) moved.push(link);
  }
  if (moved.length === 0) return { content: markdown, count: 0 };
  let content = markdown;
  let count = 0;
  for (const link of [...moved].reverse()) {
    const open = link.raw.indexOf("[[") + 2;
    const lead = /^\s*/.exec(link.raw.slice(open))?.[0].length ?? 0;
    const at = link.index + open + lead;
    // The title is whitespace-collapsed; only rewrite when the source matches.
    if (content.slice(at, at + prefix.length).toLowerCase() !== prefix) continue;
    content = `${content.slice(0, at)}${to}/${content.slice(at + prefix.length)}`;
    count += 1;
  }
  return { content, count };
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
    // A link written against the readable title Gumply used to show for a
    // slug-like file name (`[[Meeting notes]]` → meeting-notes.md, #bayuasqq).
    (page) => normalise(legacySlugTitle(page.id)) === target,
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
