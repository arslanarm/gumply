/**
 * markdown-it rules for board embeds (D30): `![[Board.canvas]]` and
 * `![[Board.canvas|480]]` (Obsidian's embed syntax; the number is the height).
 *
 * On its own line it is a block. Inside running text Obsidian renders an embed
 * as a block too, so the inline form becomes the same block (the paragraph
 * splits around it). Other `![[…]]` embeds (images, files, notes) are left to
 * their own rules.
 *
 * markdown-it's types are an optional peer dep of tiptap-markdown, hence `any`.
 */
import { formatBoardEmbed } from "@gumply/core";

/** `Board.canvas` or `Folder/Board.canvas`, then an optional `|size`. */
const EMBED = /^!\[\[([^[\]|#]+?\.canvas)(?:\|([^[\]]*))?\]\]/i;

export interface BoardEmbedMarkup {
  target: string;
  /** What followed `|`, as written ("" when absent). */
  size: string;
  raw: string;
}

/** Parse a whole `![[X.canvas|480]]` string (null when it isn't one). */
export function parseBoardEmbed(text: string): BoardEmbedMarkup | null {
  const trimmed = text.trim();
  const match = EMBED.exec(trimmed);
  if (!match || match[0].length !== trimmed.length) return null;
  return { target: (match[1] ?? "").trim(), size: (match[2] ?? "").trim(), raw: trimmed };
}

/** Markdown for an embed node: the original text when nothing changed. */
export function boardEmbedMarkdown(attrs: { target: string; size: string; raw: string }): string {
  const original = attrs.raw ? parseBoardEmbed(attrs.raw) : null;
  if (original && original.target === attrs.target && original.size === attrs.size) return original.raw;
  return formatBoardEmbed(attrs.target, attrs.size);
}

/** The height in px a `size` asks for, or null for the default. */
export function embedHeight(size: string): number | null {
  const match = /^(\d{2,4})$/.exec(size.trim());
  return match ? Number(match[1]) : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderEmbed(meta: BoardEmbedMarkup): string {
  return `<board-embed data-target="${escapeHtml(meta.target)}" data-size="${escapeHtml(meta.size)}" data-raw="${escapeHtml(meta.raw)}"></board-embed>`;
}

function blockRule(state: any, startLine: number, _endLine: number, silent: boolean): boolean {
  // Indented 4+ is a code block.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const end = state.eMarks[startLine];
  if (state.src.charCodeAt(start) !== 0x21 /* ! */) return false;
  const meta = parseBoardEmbed(state.src.slice(start, end));
  if (!meta) return false;
  if (silent) return true;
  const token = state.push("board_embed", "board-embed", 0);
  token.meta = meta;
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

function inlineRule(state: any, silent: boolean): boolean {
  const pos: number = state.pos;
  if (state.src.charCodeAt(pos) !== 0x21 /* ! */ || state.src.charCodeAt(pos + 1) !== 0x5b) return false;
  const match = EMBED.exec(state.src.slice(pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push("board_embed", "board-embed", 0);
    token.meta = { target: (match[1] ?? "").trim(), size: (match[2] ?? "").trim(), raw: match[0] } satisfies BoardEmbedMarkup;
  }
  state.pos = pos + match[0].length;
  return true;
}

export function boardEmbedMarkdownPlugin(md: any): void {
  md.block.ruler.before("paragraph", "board_embed", blockRule);
  md.inline.ruler.before("image", "board_embed_inline", inlineRule);
  md.renderer.rules.board_embed = (tokens: any[], index: number): string => {
    const token = tokens[index];
    const meta = token?.meta as BoardEmbedMarkup | undefined;
    if (!meta) return "";
    return token.block ? `${renderEmbed(meta)}\n` : renderEmbed(meta);
  };
}
