/**
 * v0.8 C1 (#sipu2nxn, spec/api-mentions): unlinked mentions, as in Obsidian.
 *
 * A mention of a page is its title, or one of its frontmatter `aliases`,
 * written as plain text in another page: word-bounded, case-insensitive,
 * never inside code, links, wikilinks, embeds, URLs or HTML. Offsets are into
 * the page body (frontmatter excluded), so a Link replaces exactly those bytes.
 */
import { maskCode } from "./links.js";
import { WIKILINK_INNER } from "./wikilink-syntax.js";

export interface MentionMatch {
  /** Offset into the body. */
  index: number;
  length: number;
  /** The text as written there. */
  text: string;
  /** The title or alias it matched. */
  term: string;
}

const WORD = String.raw`[\p{L}\p{N}_]`;
const blank = (match: string) => match.replace(/[^\n]/g, " ");

const WIKILINKS = new RegExp(String.raw`!?\[\[${WIKILINK_INNER}*\]\]`, "g");
/** `[text](url)` and `![alt](url)`, the whole thing (its text is a link already). */
const MARKDOWN_LINKS = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
/** Autolinks `<https://…>` and HTML tags. */
const ANGLE = /<[^<>\n]+>/g;
const URLS = /\b(?:https?|ftp|mailto|file|obsidian):[^\s<>()]+/gi;

/** The body with everything that can't hold an unlinked mention blanked out (offsets kept). */
export function mentionableText(markdown: string): string {
  return maskCode(markdown)
    .replace(WIKILINKS, blank)
    .replace(MARKDOWN_LINKS, blank)
    .replace(ANGLE, blank)
    .replace(URLS, blank);
}

/** Lowercase words, the index's tokens (letters, digits, `_`; any script). */
export function mentionWords(text: string): string[] {
  return text.toLowerCase().match(new RegExp(`${WORD}+`, "gu")) ?? [];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The terms a page is mentioned by: title first, then aliases; no blanks or repeats. */
export function mentionTerms(title: string, aliases: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [title, ...aliases]) {
    // As written (Obsidian 1.14.4): no whitespace normalising inside the term.
    const term = raw.trim();
    // A term with no word character can't be word-bounded (e.g. "—").
    if (!term || seen.has(term.toLowerCase()) || mentionWords(term).length === 0) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

/**
 * Every unlinked mention of `terms` in `markdown`, in order. Longer terms win
 * where they overlap. As in Obsidian 1.14.4: the term's exact character
 * sequence, case-insensitive; no whitespace normalising (two spaces don't
 * match one), and never across a line break.
 */
export function findMentions(markdown: string, terms: readonly string[]): MentionMatch[] {
  if (terms.length === 0) return [];
  const text = mentionableText(markdown);
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<!${WORD})(?:${ordered.map(escape).join("|")})(?!${WORD})`,
    "giu",
  );
  const out: MentionMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const written = markdown.slice(index, index + match[0].length);
    const folded = written.toLowerCase();
    // Blanked spans read as spaces: a match across a link or code isn't the term as written.
    const term = ordered.find((candidate) => candidate.toLowerCase() === folded);
    if (term === undefined) continue;
    out.push({ index, length: match[0].length, text: written, term });
  }
  return out;
}

/**
 * The link a mention becomes, as Obsidian 1.14.4 writes it: the text as
 * written (`[[alpha]]`) when that bare text already resolves to the page,
 * else `[[target|text as written]]` (an alias, or a title that isn't the file
 * name: `target` as `linkTargetFor` gives it).
 */
export function mentionLink(target: string, written: string, bareResolves: boolean): string {
  return bareResolves || written === target ? `[[${written}]]` : `[[${target}|${written}]]`;
}

/** Replace the given mentions with `linkFor(mention)`. Only those bytes change. */
export function linkMentions(markdown: string, mentions: readonly MentionMatch[], linkFor: (mention: MentionMatch) => string): string {
  let out = markdown;
  for (const mention of [...mentions].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, mention.index) + linkFor(mention) + out.slice(mention.index + mention.length);
  }
  return out;
}

/** A plain-text snippet around a mention, about `radius` characters each side. */
export function mentionSnippet(markdown: string, mention: MentionMatch, radius = 60): { text: string; start: number; end: number } {
  let from = Math.max(0, mention.index - radius);
  let to = Math.min(markdown.length, mention.index + mention.length + radius);
  // Cut at word edges, never mid-word ("…thouse").
  if (from > 0) {
    const space = markdown.slice(from, mention.index).search(/\s/);
    if (space !== -1) from += space + 1;
  }
  if (to < markdown.length) {
    const tail = markdown.slice(mention.index + mention.length, to);
    const space = Math.max(tail.lastIndexOf(" "), tail.lastIndexOf("\n"), tail.lastIndexOf("\t"));
    if (space !== -1) to = mention.index + mention.length + space;
  }
  const before = markdown.slice(from, mention.index).replace(/\s+/g, " ");
  const match = markdown.slice(mention.index, mention.index + mention.length).replace(/\s+/g, " ");
  const after = markdown.slice(mention.index + mention.length, to).replace(/\s+/g, " ");
  const lead = from > 0 ? "…" : "";
  const tail = to < markdown.length ? "…" : "";
  const start = lead.length + before.length;
  return { text: `${lead}${before}${match}${after}${tail}`, start, end: start + match.length };
}
