/**
 * markdown-it rule for page previews (#5dpxwac4): `![[Page]]`,
 * `![[Page#Heading]]` and `![[Page#^block]]`, Obsidian's embed syntax.
 *
 * Only an embed on a line of its own becomes the live block; inside running
 * text it stays a `!` and a `[[link]]`, so the paragraph round-trips byte for
 * byte (same rule as board embeds, D30). Boards (`.canvas`) and attachments
 * (`![[pic.png]]`) keep their own rules.
 *
 * markdown-it's types are an optional peer dep of tiptap-markdown, hence `any`.
 */
import { formatPageEmbed, hasAttachmentExtension, isBoardTarget } from "@gumply/core";

const EMBED = /^!\[\[([^[\]|#]+?)(?:#([^[\]|]*))?(?:\|([^[\]]*))?\]\]$/;

export interface PageEmbedMarkup {
  /** The page as linked: `Plan`, `Folder/Plan`. */
  target: string;
  /** What followed `#` (`Goals`, `^abc123`), "" for the whole page. */
  part: string;
  /** What followed `|`, as written. */
  alias: string;
  raw: string;
}

/** Parse a whole `![[Page#part|alias]]` string; null for boards, attachments and anything else. */
export function parsePageEmbed(text: string): PageEmbedMarkup | null {
  const trimmed = text.trim();
  const match = EMBED.exec(trimmed);
  if (!match) return null;
  const target = (match[1] ?? "").trim();
  if (!target || isBoardTarget(target) || hasAttachmentExtension(target)) return null;
  return { target, part: (match[2] ?? "").trim(), alias: (match[3] ?? "").trim(), raw: trimmed };
}

/** Markdown for an embed node: the original text when nothing changed. */
export function pageEmbedMarkdown(attrs: { target: string; part: string; alias: string; raw: string }): string {
  const original = attrs.raw ? parsePageEmbed(attrs.raw) : null;
  if (original && original.target === attrs.target && original.part === attrs.part && original.alias === attrs.alias) {
    return original.raw;
  }
  return formatPageEmbed(attrs.target, attrs.part || undefined, attrs.alias || undefined);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blockRule(state: any, startLine: number, _endLine: number, silent: boolean): boolean {
  // Indented 4+ is a code block.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const end = state.eMarks[startLine];
  if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false;
  const meta = parsePageEmbed(state.src.slice(start, end));
  if (!meta) return false;
  if (silent) return true;
  const token = state.push("page_embed", "page-embed", 0);
  token.meta = meta;
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pageEmbedMarkdownPlugin(md: any): void {
  md.block.ruler.before("paragraph", "page_embed", blockRule);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.page_embed = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as PageEmbedMarkup | undefined;
    if (!meta) return "";
    return `<page-embed data-target="${escapeHtml(meta.target)}" data-part="${escapeHtml(meta.part)}" data-alias="${escapeHtml(meta.alias)}" data-raw="${escapeHtml(meta.raw)}"></page-embed>\n`;
  };
}
