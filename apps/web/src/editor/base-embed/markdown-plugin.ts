/**
 * markdown-it rule for database view embeds (D34, spec/api-bases):
 * `![[Tasks.base]]` (the first view) and `![[Tasks.base#Board]]` (that view),
 * Obsidian's own syntax.
 *
 * As with board embeds (D30), only an embed on a line of its own becomes the
 * live block; inside running text it stays text, so the paragraph keeps its
 * bytes. An untouched embed is written back exactly as it was read.
 *
 * markdown-it's types are an optional peer dep of tiptap-markdown, hence `any`.
 */
import { formatPageEmbed } from "@gumply/core";

/** `Tasks.base` or `Folder/Tasks.base`, an optional `#View`, an optional `|alias` (kept as written). */
const EMBED = /^!\[\[([^[\]|#]+?\.base)(?:#([^[\]|]*))?(?:\|([^[\]]*))?\]\]$/i;

export interface BaseEmbedMarkup {
  target: string;
  /** The view's name after `#` ("" = the first view). */
  view: string;
  raw: string;
}

export function parseBaseEmbed(text: string): BaseEmbedMarkup | null {
  const trimmed = text.trim();
  const match = EMBED.exec(trimmed);
  if (!match) return null;
  return { target: (match[1] ?? "").trim(), view: (match[2] ?? "").trim(), raw: trimmed };
}

/** Markdown for an embed node: the original text when nothing changed. */
export function baseEmbedMarkdown(attrs: { target: string; view: string; raw: string }): string {
  const original = attrs.raw ? parseBaseEmbed(attrs.raw) : null;
  if (original && original.target === attrs.target && original.view === attrs.view) return original.raw;
  return formatPageEmbed(attrs.target, attrs.view || undefined);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function blockRule(state: any, startLine: number, _endLine: number, silent: boolean): boolean {
  // Indented 4+ is a code block.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const end = state.eMarks[startLine];
  if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false;
  const meta = parseBaseEmbed(state.src.slice(start, end));
  if (!meta) return false;
  if (silent) return true;
  const token = state.push("base_embed", "base-embed", 0);
  token.meta = meta;
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

export function baseEmbedMarkdownPlugin(md: any): void {
  md.block.ruler.before("paragraph", "base_embed", blockRule);
  md.renderer.rules.base_embed = (tokens: any[], index: number): string => {
    const meta = tokens[index]?.meta as BaseEmbedMarkup | undefined;
    if (!meta) return "";
    return `<base-embed data-target="${escapeHtml(meta.target)}" data-view="${escapeHtml(meta.view)}" data-raw="${escapeHtml(meta.raw)}"></base-embed>\n`;
  };
}
