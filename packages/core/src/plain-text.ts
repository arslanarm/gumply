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
const WIKILINK = /\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

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
    .replace(/!\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, (_match, target: string) => target.split("/").pop() ?? target)
    .replace(WIKILINK, (_match, target: string, heading = "", alias?: string) =>
      alias !== undefined && alias.trim().length > 0 ? alias : `${target}${heading}`,
    )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, "$1");
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
