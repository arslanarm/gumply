/**
 * Keep Markdown the editor doesn't model byte-for-byte (#82x82ek7).
 *
 * Opening a note from an existing (Obsidian) vault and fixing one typo used
 * to rewrite the whole file through the editor's schema: tables were
 * flattened to text, callouts merged into one line, footnotes and HTML
 * escaped. Now such constructs become opaque "raw" nodes holding their exact
 * source, which the serializer writes back unchanged:
 *
 * - blocks (top level): footnote definitions (`[^1]: …`), math blocks
 *   (`$$ … $$`), and HTML blocks at any depth (callouts are editable nodes
 *   now, see editor/callout);
 * - inline: footnote references `[^1]`, `==highlight==`, inline math `$x$`,
 *   inline HTML (`<kbd>`, `<br>`, `<!-- -->`).
 *
 * HTML is recognised (markdown-it `html: true`) only so it can be captured:
 * every HTML token is rendered as an escaped `data-` attribute and never
 * reaches the DOM as markup.
 *
 * Hard breaks also remember their source style (two trailing spaces vs
 * backslash) so an unrelated edit doesn't rewrite them.
 */

/* markdown-it is an untyped optional peer dep here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { calloutRule, installCalloutRenderer } from "../callout/markdown.js";
import { markupRule } from "./markup.js";
import { inlineImageRule } from "../attachments/inline-image.js";

export const RAW_BLOCK_ATTR = "data-raw-md";
export const RAW_INLINE_ATTR = "data-raw-md-inline";
export const BREAK_STYLE_ATTR = "data-md-break";

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

/** Index of the token closing the block opened at `start` (same level). */
function closingIndex(tokens: any[], start: number): number {
  const open = tokens[start];
  if (open.nesting !== 1) return start;
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    depth += tokens[i].nesting;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Cells in a GFM table row: split on unescaped pipes (code spans too, per GFM). */
export function countRowCells(line: string): number {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  let cells = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "|") cells += 1;
  }
  return cells;
}

/**
 * A GFM table whose rows have more cells than its header (typically an
 * unescaped `|` in code or `[[Page|alias]]`): markdown-it drops the extra
 * cells, so editing it as a table would lose that text. Keep it raw.
 */
function tableOverflows(source: string): boolean {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (!header) return false;
  const width = countRowCells(header);
  return lines.slice(2).some((line) => countRowCells(line) > width);
}

/** Which top-level block starting at `index` must be kept as raw source. */
function rawKind(tokens: any[], index: number, source: string): string | null {
  const token = tokens[index];
  if (token.type === "table_open" && tableOverflows(source)) return "table";
  if (token.type === "paragraph_open") {
    if (FOOTNOTE_DEF.test(source)) return "footnote";
    const trimmed = source.trim();
    if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) return "math";
    // Obsidian block comment `%%\n…\n%%`.
    if (trimmed.startsWith("%%") && trimmed.endsWith("%%") && trimmed.length >= 4) return "comment";
  }
  return null;
}

/**
 * Sources of the top-level GFM tables of the last parse, in document order
 * (#7witbbun). Tables are real editable nodes; the editor pairs these with
 * them on load so an untouched table is written back byte-for-byte.
 */
let lastTableSources: Array<string | null> = [];

/** Sources of every editable table of the last parse, in document order (null: re-serialize). */
export function lastParsedTableSources(): Array<string | null> {
  return lastTableSources;
}

/**
 * Source of a table nested in a list item, dedented to its own column so it
 * can be written back inside the item or quote (prefixes are re-added by the
 * serializer). Lazily continued quote lines can't be paired (null).
 */
function nestedTableSource(lines: string[], [start, end]: [number, number]): string | null {
  let last = end;
  while (last > start && isBlank(lines[last - 1])) last -= 1;
  let block = lines.slice(start, last);
  // Inside a quote: strip the quote markers; the serializer writes them back.
  const depth = (/^\s*((?:>\s?)+)/.exec(block[0] ?? "")?.[1] ?? "").replace(/[^>]/g, "").length;
  if (depth > 0) {
    const prefix = new RegExp(`^\\s*(?:>\\s?){${depth}}`);
    if (!block.every((line) => prefix.test(line))) return null;
    block = block.map((line) => line.replace(prefix, ""));
  }
  // A table starting on the list marker line (`- | a |`) can't be dedented.
  if (/^\s*([-*+]|\d+[.)])\s/.test(block[0] ?? "")) return null;
  const indent = Math.min(...block.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  return block.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length))).join("\n");
}

function rawBlocksRule(state: any): void {
  const lines: string[] = state.src.split("\n");
  const tokens: any[] = state.tokens;
  const out: any[] = [];
  const tableSources: Array<string | null> = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "table_open" && token.level > 0 && token.map) {
      tableSources.push(nestedTableSource(lines, token.map as [number, number]));
    }
    if (token.level !== 0 || token.nesting !== 1 || !token.map) {
      out.push(token);
      continue;
    }
    const [startLine, endLine] = token.map as [number, number];
    let contentEnd = endLine;
    while (contentEnd > startLine && isBlank(lines[contentEnd - 1])) contentEnd -= 1;
    const source = lines.slice(startLine, contentEnd).join("\n");

    const kind = rawKind(tokens, i, source);
    if (token.type === "table_open" && !kind) tableSources.push(source);

    if (!kind) {
      out.push(token);
      continue;
    }
    const raw = new state.Token("gumply_raw_block", "div", 0);
    raw.block = true;
    raw.level = 0;
    raw.map = [startLine, contentEnd];
    raw.content = source;
    raw.info = kind;
    out.push(raw);
    i = closingIndex(tokens, i);
  }
  state.tokens = out;
  lastTableSources = tableSources;
}

/** `[^id]`, `==text==` and Obsidian-style `$math$` as raw inline atoms. */
function rawInlineRule(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const pos: number = state.pos;
  const rest = src.slice(pos);
  let match: RegExpExecArray | null = null;
  let kind = "";

  if (src[pos] === "[" && src[pos + 1] === "^") {
    match = /^\[\^[^\]\s]+\]/.exec(rest);
    kind = "footnote-ref";
  } else if (src[pos] === "=" && src[pos + 1] === "=") {
    match = /^==(?=\S)([^=\n]|=(?!=))*?\S==/.exec(rest) ?? /^==\S==/.exec(rest);
    kind = "highlight";
  } else if (src[pos] === "$" && src[pos + 1] !== "$" && src[pos - 1] !== "\\") {
    // Obsidian rule: no space inside the delimiters, no digit right after.
    match = /^\$(?=\S)[^$\n]*?\S\$(?!\d)/.exec(rest) ?? /^\$[^\s$]\$(?!\d)/.exec(rest);
    kind = "math";
  }
  if (!match) return false;

  if (!silent) {
    const token = state.push("gumply_raw_inline", "span", 0);
    token.content = match[0];
    token.info = kind;
  }
  state.pos += match[0].length;
  return true;
}

/**
 * Record each hard break's source style. Inline tokens carry their raw text,
 * so the n-th break token matches the n-th `  \n` / `\\\n` in it.
 */
function breakStyleRule(state: any): void {
  for (const block of state.tokens as any[]) {
    if (block.type !== "inline" || !block.children) continue;
    const breaks = (block.children as any[]).filter((t) => t.type === "hardbreak");
    if (breaks.length === 0) continue;
    const styles = [...(block.content as string).matchAll(/( {2,}|\\)\n/g)].map((m) =>
      m[1] === "\\" ? "backslash" : "spaces",
    );
    if (styles.length !== breaks.length) continue;
    breaks.forEach((token, index) => token.attrSet(BREAK_STYLE_ATTR, styles[index]));
  }
}

/**
 * Keep HTML entities as typed (`&nbsp;`, `&copy;`): markdown-it decodes them
 * into the text, so an edit used to write a literal NBSP / ©. Runs before
 * markdown-it joins `text_special` tokens back into plain text.
 */
function entityRule(state: any): void {
  for (const block of state.tokens as any[]) {
    if (block.type !== "inline" || !block.children) continue;
    for (const token of block.children as any[]) {
      if (token.type === "text_special" && token.info === "entity" && /^&[#\w]+;$/.test(token.markup)) {
        token.type = "gumply_raw_inline";
        token.content = token.markup;
        token.info = "entity";
      }
    }
  }
}

export const AUTOLINK_ATTR = "data-md-autolink";

export const IMAGE_RAW_ATTR = "data-md-raw";

/**
 * End of a `[label](dest "title")` / `![…](…)` whose destination markdown-it
 * refuses (`javascript:`, `vbscript:`, `file:`, non-image `data:`), or -1.
 * Such links used to degrade to text and be saved escaped (`!\[c\](…)`),
 * which changes the file and its meaning in other tools (#2ijnyid6).
 */
function blockedLinkEnd(state: any, isImage: boolean): number {
  const src: string = state.src;
  const max: number = state.posMax;
  const open = isImage ? state.pos + 1 : state.pos;
  if (src[open] !== "[") return -1;
  const labelEnd = state.md.helpers.parseLinkLabel(state, open, !isImage);
  if (labelEnd < 0 || src[labelEnd + 1] !== "(") return -1;
  let pos = labelEnd + 2;
  while (pos < max && /\s/.test(src[pos]!)) pos += 1;
  const dest = state.md.helpers.parseLinkDestination(src, pos, max);
  if (!dest.ok) return -1;
  if (state.md.validateLink(state.md.normalizeLink(dest.str))) return -1;
  pos = dest.pos;
  const afterDest = pos;
  while (pos < max && /\s/.test(src[pos]!)) pos += 1;
  const title = state.md.helpers.parseLinkTitle(src, pos, max);
  if (pos < max && pos !== afterDest && title.ok) {
    pos = title.pos;
    while (pos < max && /\s/.test(src[pos]!)) pos += 1;
  }
  return src[pos] === ")" ? pos + 1 : -1;
}

/**
 * Wrap markdown-it's `image` / `link` rules:
 * - a parsed image remembers its exact source (`![a](<my pic.png>)`), written
 *   back while src/alt/title are unchanged;
 * - a link/image with a refused scheme becomes an inert raw inline atom: shown
 *   as text, never live, written back verbatim.
 */
function wrapLinkRules(md: any): void {
  const rules = md.inline.ruler.__rules__ as Array<{ name: string; fn: any }>;
  for (const name of ["image", "link"]) {
    const original = rules.find((rule) => rule.name === name)?.fn;
    if (!original) continue;
    const isImage = name === "image";
    md.inline.ruler.at(name, (state: any, silent: boolean) => {
      const start = state.pos;
      if (original(state, silent)) {
        if (!silent && isImage) {
          const token = state.tokens[state.tokens.length - 1];
          if (token?.type === "image") token.attrSet(IMAGE_RAW_ATTR, state.src.slice(start, state.pos));
        }
        return true;
      }
      if (isImage ? state.src[start] !== "!" : state.src[start] !== "[") return false;
      const end = blockedLinkEnd(state, isImage);
      if (end < 0) return false;
      if (!silent) {
        const token = state.push("gumply_raw_inline", "span", 0);
        token.content = state.src.slice(start, end);
        token.info = "inert";
      }
      state.pos = end;
      return true;
    });
  }
}

const INSTALLED = Symbol.for("gumply.rawMarkdown");

export function rawMarkdownPlugin(md: any): void {
  if (md[INSTALLED]) return;
  md[INSTALLED] = true;

  // Recognise HTML so it can be captured below; it is never rendered as HTML.
  md.set({ html: true });

  md.core.ruler.after("block", "gumply_callouts", calloutRule);
  md.core.ruler.after("gumply_callouts", "gumply_raw_blocks", rawBlocksRule);
  md.core.ruler.after("gumply_raw_blocks", "gumply_markup", markupRule);
  md.core.ruler.after("inline", "gumply_break_style", breakStyleRule);
  md.core.ruler.after("gumply_break_style", "gumply_inline_images", inlineImageRule);
  if (md.core.ruler.__find__("text_join") !== -1) {
    md.core.ruler.before("text_join", "gumply_entities", entityRule);
  }
  md.inline.ruler.before("link", "gumply_raw_inline", rawInlineRule);
  wrapLinkRules(md);

  const block = (source: string, kind: string) =>
    `<div ${RAW_BLOCK_ATTR}="${escapeAttr(source)}" data-raw-kind="${escapeAttr(kind)}"></div>`;
  const inline = (source: string, kind: string) =>
    `<span ${RAW_INLINE_ATTR}="${escapeAttr(source)}" data-raw-kind="${escapeAttr(kind)}"></span>`;

  installCalloutRenderer(md);
  md.renderer.rules.gumply_raw_block = (tokens: any[], index: number) =>
    block(tokens[index].content, tokens[index].info);
  md.renderer.rules.gumply_raw_inline = (tokens: any[], index: number) =>
    inline(tokens[index].content, tokens[index].info);
  md.renderer.rules.html_block = (tokens: any[], index: number) =>
    block(String(tokens[index].content).replace(/\n+$/, ""), "html");
  md.renderer.rules.html_inline = (tokens: any[], index: number) => {
    const content = String(tokens[index].content);
    // markdown-it-task-lists injects its checkbox as an html_inline token;
    // that one is ours, not vault HTML.
    if (/^<input class="task-list-item-checkbox"[^<>]*>$/.test(content)) return content;
    return inline(content, "html");
  };
  // `<https://x>` keeps its angle brackets on save (see editor/link.ts).
  const linkOpen =
    md.renderer.rules.link_open ??
    ((tokens: any[], index: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens: any[], index: number, ...rest: any[]) => {
    if (tokens[index].markup === "autolink") tokens[index].attrSet(AUTOLINK_ATTR, "1");
    return linkOpen(tokens, index, ...rest);
  };

  md.renderer.rules.hardbreak = (tokens: any[], index: number) => {
    const style = tokens[index].attrGet(BREAK_STYLE_ATTR);
    return style ? `<br ${BREAK_STYLE_ATTR}="${style}">` : "<br>";
  };
}
