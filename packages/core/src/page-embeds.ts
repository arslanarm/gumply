/**
 * Page previews (#5dpxwac4): which part of a page `![[Page#…]]` shows.
 *
 * - `![[Page]]`: the whole page;
 * - `![[Page#Heading]]`: the heading and its section, up to the next heading of
 *   the same or a higher level (Obsidian's rule);
 * - `![[Page#^id]]`: the block that ends with ` ^id` (Obsidian's block ids).
 *
 * Headings and block ids inside fenced code never count. Everything here is
 * pure and works on the page body (Markdown without frontmatter).
 */

export type EmbedPart =
  | { kind: "page" }
  | { kind: "heading"; heading: string }
  | { kind: "block"; id: string };

/** What `#…` after the page name asks for. */
export function parseEmbedPart(subpath: string | undefined): EmbedPart {
  const value = (subpath ?? "").trim();
  if (!value) return { kind: "page" };
  if (value.startsWith("^")) return { kind: "block", id: value.slice(1).trim() };
  // Obsidian allows `Page#Parent#Child`: the last heading is the one shown.
  const parts = value.split("#").map((part) => part.trim()).filter(Boolean);
  return { kind: "heading", heading: parts[parts.length - 1] ?? value };
}

export interface OutlineHeading {
  level: number;
  text: string;
  /** Line index in the body. */
  line: number;
}

export interface OutlineBlock {
  id: string;
  /** The block's text without its id, for the picker. */
  text: string;
  line: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A block id at the end of a line: ` ^abc-123`. */
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;

/** Lines of `markdown`, each marked as inside a fenced code block or not. */
function scanLines(markdown: string): Array<{ text: string; code: boolean }> {
  let fence: { char: string; length: number } | null = null;
  return markdown.split("\n").map((text) => {
    const match = FENCE.exec(text);
    if (fence) {
      if (match && match[1]?.[0] === fence.char && (match[1]?.length ?? 0) >= fence.length) fence = null;
      return { text, code: true };
    }
    if (match?.[1]) {
      fence = { char: match[1][0] ?? "`", length: match[1].length };
      return { text, code: true };
    }
    return { text, code: false };
  });
}

/** Heading text as Obsidian compares it: inline Markdown and links reduced to their words. */
export function headingKey(text: string): string {
  return text
    .replace(/\[\[([^\]|\r\n]*)\|([^\]\r\n]*)\]\]/g, "$2")
    .replace(/\[\[([^\]\r\n]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~=]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The page's headings, in order (not those in code). */
export function pageHeadings(markdown: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  scanLines(markdown).forEach(({ text, code }, line) => {
    if (code) return;
    const match = HEADING.exec(text);
    if (match) out.push({ level: match[1]!.length, text: (match[2] ?? "").trim(), line });
  });
  return out;
}

/**
 * The section under `heading`: its heading line and everything up to the next
 * heading of the same or a higher level. The first match wins when headings
 * repeat. Null when the page has no such heading.
 */
export function pageSection(markdown: string, heading: string): string | null {
  const wanted = headingKey(heading);
  const headings = pageHeadings(markdown);
  const index = headings.findIndex((item) => headingKey(item.text) === wanted);
  if (index === -1) return null;
  const start = headings[index]!;
  const end = headings.slice(index + 1).find((item) => item.level <= start.level);
  const lines = markdown.split("\n");
  return trimBlankLines(lines.slice(start.line, end ? end.line : lines.length)).join("\n");
}

/** Block ids defined in the page, with a short text for each (not those in code). */
export function pageBlockIds(markdown: string): OutlineBlock[] {
  const out: OutlineBlock[] = [];
  const lines = scanLines(markdown);
  lines.forEach(({ text, code }, line) => {
    if (code) return;
    const match = BLOCK_ID.exec(text);
    if (!match) return;
    const own = text.trim().startsWith("^");
    // An id on its own line names the block just above it (tables, quotes).
    const source = own ? (lines.slice(0, line).reverse().find((item) => item.text.trim() !== "")?.text ?? "") : text;
    out.push({ id: match[1]!, text: previewLine(source.replace(BLOCK_ID, "")), line });
  });
  return out;
}

function previewLine(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;

/**
 * The block ` ^id` marks, without the marker: a list item (with its nested
 * lines), a heading, or the paragraph/quote/table it ends. An id on a line of
 * its own marks the block just above. Null when no block has that id.
 */
export function pageBlock(markdown: string, id: string): string | null {
  const lines = scanLines(markdown);
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`);
  const at = lines.findIndex(({ text, code }) => !code && marker.test(text));
  if (at === -1) return null;
  const raw = lines.map((line) => line.text);
  const strip = (text: string) => text.replace(marker, "").replace(/\s+$/, "");

  // Own line: the block just above (up to the blank line before it).
  if (raw[at]!.trim().startsWith("^")) {
    let end = at - 1;
    while (end >= 0 && raw[end]!.trim() === "") end -= 1;
    if (end < 0) return null;
    let start = end;
    while (start > 0 && raw[start - 1]!.trim() !== "") start -= 1;
    return trimBlankLines(raw.slice(start, end + 1)).join("\n");
  }

  if (HEADING.test(raw[at]!)) return strip(raw[at]!);

  // A list item: its line(s), plus nested lines indented deeper.
  let item = at;
  while (item >= 0 && !LIST_ITEM.test(raw[item]!) && raw[item]!.trim() !== "") item -= 1;
  if (item >= 0 && LIST_ITEM.test(raw[item]!)) {
    const indent = LIST_ITEM.exec(raw[item]!)![1]!.length;
    let end = at;
    for (let next = at + 1; next < raw.length; next += 1) {
      const line = raw[next]!;
      if (line.trim() === "") break;
      const nested = LIST_ITEM.exec(line);
      const lineIndent = line.length - line.trimStart().length;
      if (nested ? nested[1]!.length <= indent : lineIndent <= indent) break;
      end = next;
    }
    const block = raw.slice(item, end + 1);
    block[at - item] = strip(block[at - item]!);
    // Shown as a list item of its own, not indented under a missing parent.
    return dedent(block).join("\n");
  }

  // A paragraph, quote or table: the lines between blank lines.
  let start = at;
  while (start > 0 && raw[start - 1]!.trim() !== "" && !HEADING.test(raw[start - 1]!)) start -= 1;
  const block = raw.slice(start, at + 1);
  block[block.length - 1] = strip(block[block.length - 1]!);
  return block.join("\n");
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)));
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a preview of `part` shows of `markdown`; null when the heading or block is missing. */
export function embeddedMarkdown(markdown: string, part: EmbedPart): string | null {
  if (part.kind === "page") return markdown;
  if (part.kind === "heading") return pageSection(markdown, part.heading);
  return pageBlock(markdown, part.id);
}

/** A new block id: 6 lowercase letters and digits, unused in `markdown`. */
export function newBlockId(markdown: string, random: () => number = Math.random): string {
  const taken = new Set(pageBlockIds(markdown).map((block) => block.id));
  for (;;) {
    let id = "";
    for (let index = 0; index < 6; index += 1) id += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
    if (!taken.has(id)) return id;
  }
}
