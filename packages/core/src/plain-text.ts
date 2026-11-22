/**
 * What a Markdown page reads as on screen, for search (#6zifz7da): a phrase
 * that crosses formatting or a link ("bold text" in `**bold** text`, "See
 * Getting started" in `See [[Getting started]]`) must still be found, and
 * snippets shouldn't show markup.
 *
 * - Inline: emphasis/strike/highlight/code marks dropped; `[[Target|Alias]]`
 *   → Alias, `[[Target#H]]` → Target#H; `[text](url)` → text; `![alt](x)` →
 *   alt; `![[file]]` → file name; HTML tags dropped; backslash escapes undone.
 * - Blocks: heading, quote, list and to-do markers, callout markers, table
 *   pipes and separator rows, fences dropped; code text itself is kept (it is
 *   searchable content).
 * - Whitespace collapses to single spaces, so phrases match across soft line
 *   breaks.
 */
import { WIKILINK_INNER, WIKILINK_PART, WIKILINK_TARGET } from "./wikilink-syntax.js";

const WIKILINK = new RegExp(String.raw`\[\[(${WIKILINK_TARGET}*)(#${WIKILINK_PART}*)?(?:\|(${WIKILINK_INNER}*))?\]\]`, "g");
const EMBED = new RegExp(String.raw`!\[\[(${WIKILINK_PART}*)(?:\|${WIKILINK_INNER}*)?\]\]`, "g");
const ALIASED = new RegExp(String.raw`!?\[\[(${WIKILINK_TARGET}*)(#${WIKILINK_PART}*)?\|(${WIKILINK_INNER}+)\]\]`, "g");

// Backslash-escaped punctuation is literal text: hide it from the markup
// rules (private-use characters) and restore it at the end.
const ESCAPE_BASE = 0xe000;
const hideEscapes = (text: string) =>
  text.replace(/\\([!-/:-@[-`{-~])/g, (_m, char: string) => String.fromCharCode(ESCAPE_BASE + char.charCodeAt(0)));
const restoreEscapes = (text: string) =>
  text.replace(/[\ue000-\ue07f]/g, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPE_BASE));

/** Links first (their `|` is not a table pipe), then marks. */
function links(text: string): string {
  return text
    .replace(EMBED, (_match, target: string) => target.split("/").pop() ?? target)
    .replace(WIKILINK, (_match, target: string, heading = "", alias?: string) =>
      alias !== undefined && alias.trim().length > 0 ? alias : `${target}${heading}`,
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    // Autolinks show their URL (before HTML tags are stripped).
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
}

function marks(text: string): string {
  return (
    text
      .replace(/<\/?[A-Za-z][^>]*>/g, " ")
      // Footnote references.
      .replace(/\[\^[^\]]+\]/g, "")
      .replace(/`+([^`]*?)`+/g, "$1")
      .replace(/(\*\*|__|~~|==)(?=\S)([^]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
  );
}

export function plainText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      else out.push(raw);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    let line = hideEscapes(raw);
    // Table separator rows (`|---|:-:|`) carry no text.
    if (/^\s*\|?[\s:|-]*-[\s:|-]*$/.test(line) && line.includes("|")) continue;
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*(>\s*)+/, "")
      .replace(/^\[!\w+\][+-]?\s*/, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$|^\s*(_\s*){3,}$/, "");
    line = links(line);
    // Table rows: cells separated by pipes (after links, whose `|` is gone).
    if (/^\s*\|/.test(line)) line = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, " ");
    out.push(restoreEscapes(marks(line)));
  }
  return out.join("\n").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The "Linked from" snippet (#zrxjbn6e): the link itself stays raw
 * (`[[Target|alias]]`, so the panel can highlight it) and the text around it
 * reads as on screen, like Cmd+K snippets: no heading, list or to-do markers,
 * other links as their text. About `radius` visible characters each side, cut
 * at word boundaries, with "…" where text was left out.
 *
 * Context is taken from whole lines (before) and with a guard character
 * (after), so line-start markers are recognised and text right after the link
 * is never mistaken for one.
 */
export function linkSnippet(markdown: string, index: number, length: number, radius = 60): string {
  const raw = markdown.slice(index, index + length);
  // Enough raw text for `radius` visible characters even under heavy markup.
  const span = radius * 6;
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, index - span)) + 1;
  const rawBefore = markdown.slice(index - span > 0 ? lineStart : 0, index);
  const afterEnd = Math.min(markdown.length, index + length + span);
  const rawAfter = markdown.slice(index + length, afterEnd);

  // Emphasis that opens before the link and closes after it has no pair on
  // either side; drop the orphaned markers.
  const orphans = (text: string) => text.replace(/\*\*|__|~~|==/g, "");
  let before = orphans(plainText(rawBefore));
  // A table row keeps its pipe guard so its cells still split; elsewhere a
  // letter guard stops "- text" after the link from reading as a list item.
  const inTable = /^\s*\|/.test(markdown.slice(markdown.lastIndexOf("\n", index - 1) + 1, index));
  const guarded = plainText(`${inTable ? "|" : "x"}${rawAfter}`);
  let after = orphans(inTable ? guarded : guarded.slice(1)).trimStart();
  const cutBefore = before.length > radius;
  if (cutBefore) {
    before = before.slice(-radius);
    const space = before.indexOf(" ");
    if (space >= 0 && space < before.length - 1) before = before.slice(space + 1);
  }
  const cutAfter = after.length > radius || afterEnd < markdown.length;
  if (after.length > radius) {
    after = after.slice(0, radius);
    const space = after.lastIndexOf(" ");
    if (space > 0) after = after.slice(0, space);
  }

  // Keep the spacing the reader sees around the link ("See [[X]]." vs "[[X]]s").
  const gapBefore = before.length > 0 && /\s$/.test(rawBefore) ? " " : "";
  const gapAfter = after.length > 0 && /^\s/.test(rawAfter) ? " " : "";
  const startsMid = cutBefore || (before.length > 0 && rawBefore.length < index);
  return `${startsMid ? "…" : ""}${before}${gapBefore}${raw}${gapAfter}${after}${cutAfter && after.length > 0 ? "…" : ""}`;
}

export interface MarkdownLink {
  /** Where it points: a URL, file path or `[[page]]` target. */
  target: string;
  /** What the reader sees (may be empty for an image without alt text). */
  text: string;
}

/**
 * Link targets hidden by `plainText` (#6zifz7da review): pasted URLs stay
 * searchable ("figma.com"): `[t](url)`, `![alt](url)` and `[[Target|Alias]]`.
 * Bare URLs and `<url>` autolinks are already in the plain text. Code is skipped.
 */
export function markdownLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const text = markdown.replace(/^\s*(`{3,}|~{3,})[^]*?^\s*\1[^\n]*$/gm, "").replace(/`+[^`\n]*`+/g, "");
  for (const match of text.matchAll(/!?\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    links.push({ target: match[2]!.replace(/^<|>$/g, ""), text: plainText(match[1]!) });
  }
  for (const match of text.matchAll(ALIASED)) {
    links.push({ target: `${match[1]}${match[2] ?? ""}`, text: match[3]!.trim() });
  }
  return links;
}
