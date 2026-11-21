/**
 * Inline `#tags` (#9bx3aznb): one scanner for the tag index, the tags pane
 * and renaming a tag everywhere, with Obsidian's rules:
 * - after the start of a line, a space or an opening bracket or quote;
 * - a letter or digit, then letters, digits, `_`, `/` and `-`;
 * - at least one character that isn't a digit (`#2024` is not a tag);
 * - never in code, URLs, Markdown link targets (`](#anchor)`) or `[[wikilinks]]`.
 */
import { maskCode } from "./links.js";

export interface InlineTag {
  /** The tag without `#`, trailing `/` and `-` dropped. */
  tag: string;
  /** Index of the `#`. */
  index: number;
}

const TAG_PATTERN = /(^|[\s([{>"'])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

/** Blank a match out, keeping offsets and line breaks. */
const blank = (match: string) => match.replace(/[^\n]/g, " ");

/** Code, URLs, link targets and wikilinks blanked out (same length as `markdown`). */
function maskNonTags(markdown: string): string {
  return maskCode(markdown)
    .replace(/\[\[[^\]\n]*\]\]/g, blank)
    .replace(/\]\([^)\n]*\)/g, (match) => `]${blank(match.slice(1))}`)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]*/gi, blank);
}

/** Obsidian's rule: a tag needs at least one character that isn't a digit. */
export function isTagLike(tag: string): boolean {
  return /\D/.test(tag);
}

/** Every inline tag in `markdown`, in order (repeats included). */
export function findInlineTags(markdown: string): InlineTag[] {
  if (!markdown.includes("#")) return [];
  const text = maskNonTags(markdown);
  const found: InlineTag[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = (match[2] ?? "").replace(/[/-]+$/, "");
    if (tag.length === 0 || !isTagLike(tag)) continue;
    found.push({ tag, index: (match.index ?? 0) + (match[1] ?? "").length });
  }
  return found;
}

/**
 * A name a tag can be renamed to: what the scanner reads back as exactly
 * that tag (no spaces or `#`, not only digits, no empty `a//b` levels).
 */
export function isValidTagName(name: string): boolean {
  return (
    /^[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u.test(name) &&
    !/[/-]$/.test(name) &&
    !name.includes("//") &&
    isTagLike(name)
  );
}

/** `tag` is `from` or nested under it (case-insensitive, like Obsidian). */
export function tagMatches(tag: string, from: string): boolean {
  const a = tag.toLowerCase();
  const b = from.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

/** `from` → `to` at the start of `tag`, keeping nested levels (`a/x` → `b/x`). */
export function renamedTag(tag: string, from: string, to: string): string {
  return `${to}${tag.slice(from.length)}`;
}

export interface TagRewrite {
  content: string;
  /** Inline tags rewritten. */
  count: number;
}

/** Rename `#from` (and `#from/…`) to `#to` in a note's body. Nothing else changes. */
export function renameInlineTag(markdown: string, from: string, to: string): TagRewrite {
  const hits = findInlineTags(markdown).filter((hit) => tagMatches(hit.tag, from));
  if (hits.length === 0) return { content: markdown, count: 0 };
  let content = markdown;
  for (const hit of [...hits].reverse()) {
    const start = hit.index + 1;
    content = content.slice(0, start) + renamedTag(hit.tag, from, to) + content.slice(start + hit.tag.length);
  }
  return { content, count: hits.length };
}

/**
 * Rename in a frontmatter tag list, keeping its order; a tag that now
 * repeats another is dropped. `null` when nothing matched.
 */
export function renameTagList(tags: readonly string[], from: string, to: string): string[] | null {
  if (!tags.some((tag) => tagMatches(tag, from))) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const next = tagMatches(tag, from) ? renamedTag(tag, from, to) : tag;
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}
