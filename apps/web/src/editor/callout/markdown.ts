/**
 * Callouts and toggles in Markdown (D29, #uigzc42i): Obsidian callout syntax.
 *
 *   > [!tip] Title          a callout
 *   > [!note]- Title        a toggle, closed by default
 *   > [!note]+ Title        a toggle, open by default
 *   > body blocks…
 *
 * Parsing turns a blockquote whose first line is `[!type]` into callout
 * tokens (any depth, so `>>` nesting works) and remembers the callout's exact
 * source. Serializing writes that source back while the callout is unchanged,
 * otherwise it writes the canonical form above.
 */

/* markdown-it is an untyped optional peer dep here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { CalloutFold } from "./types.js";

export const CALLOUT_ATTR = "data-gumply-callout";
export const CALLOUT_TITLE_ATTR = "data-callout-title";
export const CALLOUT_SOURCE_ATTR = "data-md-source";

/** First line of a callout: `[!type]`, an optional fold marker, the title. */
export const CALLOUT_HEAD = /^\[!([\w-]+)\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/;

export interface CalloutHead {
  type: string;
  fold: CalloutFold;
  title: string;
}

export function parseCalloutHead(line: string): CalloutHead | null {
  const match = CALLOUT_HEAD.exec(line);
  if (!match) return null;
  return { type: match[1]!, fold: (match[2] ?? "") as CalloutFold, title: match[3] ?? "" };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

/**
 * The callout's own source, relative to its nesting: the quote markers of
 * enclosing quotes/callouts and a list indent are removed (the serializer
 * adds them back). Null when it can't be cut out cleanly (lazy continuation
 * lines in a nested quote, a callout on a list marker line).
 */
export function calloutSource(lines: readonly string[], [start, end]: [number, number], outerQuotes: number): string | null {
  let block = lines.slice(start, end);
  if (outerQuotes > 0) {
    const prefix = new RegExp(`^\\s*(?:>[ \\t]?){${outerQuotes}}`);
    if (!block.every((line) => prefix.test(line))) return null;
    block = block.map((line) => line.replace(prefix, ""));
  }
  while (block.length > 0 && isBlank(block[block.length - 1])) block.pop();
  if (block.length === 0 || /^\s*([-*+]|\d+[.)])\s/.test(block[0]!)) return null;
  const indent = Math.min(...block.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  if (indent > 3 && outerQuotes === 0) return null;
  return block.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length))).join("\n");
}

function closingIndex(tokens: any[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    depth += tokens[i].nesting;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Core rule (after `block`): blockquotes starting with `[!type]` become callouts. */
export function calloutRule(state: any): void {
  const lines: string[] = state.src.split("\n");
  const tokens: any[] = state.tokens;
  let quotes = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "blockquote_close" || token.type === "gumply_callout_close") {
      quotes -= 1;
      continue;
    }
    if (token.type !== "blockquote_open") continue;
    const outer = quotes;
    quotes += 1;
    const open = tokens[i + 1];
    const inline = tokens[i + 2];
    if (open?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const [firstLine, ...rest] = String(inline.content).split("\n");
    const head = parseCalloutHead(firstLine ?? "");
    if (!head) continue;

    const close = closingIndex(tokens, i);
    token.type = "gumply_callout_open";
    tokens[close].type = "gumply_callout_close";
    token.meta = {
      ...head,
      source: token.map ? calloutSource(lines, token.map, outer) : null,
    };
    open.type = "gumply_callout_title_open";
    tokens[i + 3].type = "gumply_callout_title_close";
    inline.content = head.title;
    if (inline.map) inline.map = [inline.map[0], inline.map[0] + 1];

    // Lines after the head in the same paragraph are the body's first paragraph.
    const body = rest.join("\n");
    if (body.trim()) {
      const level = open.level;
      const paragraphOpen = new state.Token("paragraph_open", "p", 1);
      paragraphOpen.block = true;
      paragraphOpen.level = level;
      const text = new state.Token("inline", "", 0);
      text.content = body;
      text.level = level + 1;
      text.children = [];
      const paragraphClose = new state.Token("paragraph_close", "p", -1);
      paragraphClose.block = true;
      paragraphClose.level = level;
      if (open.map) {
        paragraphOpen.map = [open.map[0] + 1, open.map[1]];
        text.map = paragraphOpen.map;
      }
      tokens.splice(i + 4, 0, paragraphOpen, text, paragraphClose);
    }
  }
}

export function installCalloutRenderer(md: any): void {
  md.renderer.rules.gumply_callout_open = (tokens: any[], index: number) => {
    const meta = tokens[index].meta as CalloutHead & { source: string | null };
    const source = meta.source === null ? "" : ` ${CALLOUT_SOURCE_ATTR}="${escapeAttr(meta.source)}"`;
    return `<div ${CALLOUT_ATTR}="${escapeAttr(meta.type)}" data-fold="${meta.fold}"${source}>\n`;
  };
  md.renderer.rules.gumply_callout_close = () => "</div>\n";
  md.renderer.rules.gumply_callout_title_open = () => `<div ${CALLOUT_TITLE_ATTR}="">`;
  md.renderer.rules.gumply_callout_title_close = () => "</div>\n";
}

/** The bits of prosemirror-markdown's serializer state used here. */
export interface CalloutSerializerState {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, f: () => void): void;
  render(node: PMNode, parent: PMNode, index: number): void;
  renderInline(parent: PMNode): void;
}

/** A body that is one empty paragraph is written as no body at all. */
export function isEmptyBody(callout: PMNode): boolean {
  if (callout.childCount !== 2) return callout.childCount < 2;
  const only = callout.child(1);
  return only.type.name === "paragraph" && only.content.size === 0;
}

/**
 * Write a callout. `kept` returns the original source when the node is
 * unchanged since it was read (byte-for-byte), else null.
 */
export function serializeCallout(
  state: CalloutSerializerState,
  node: PMNode,
  kept?: (node: PMNode) => string | null,
): void {
  const source = kept?.(node) ?? null;
  if (source !== null) {
    state.text(source, false);
    state.closeBlock(node);
    return;
  }
  state.wrapBlock("> ", null, node, () => {
    state.write(`[!${String(node.attrs.type || "note")}]${String(node.attrs.fold ?? "")}`);
    const title = node.firstChild;
    if (title && title.type.name === "calloutTitle" && title.content.size > 0) {
      state.write(" ");
      state.renderInline(title);
    }
    if (isEmptyBody(node)) return;
    state.ensureNewLine();
    node.forEach((child, _offset, index) => {
      if (index === 0 && child.type.name === "calloutTitle") return;
      state.render(child, node, index);
    });
  });
}

/** Replace the head of a callout source (`[!type]±`), keeping the rest byte-for-byte. */
export function retargetSource(source: string | null, type: string, fold: CalloutFold): string | null {
  if (source === null) return null;
  const match = /^(>[ \t]?)\[![\w-]+\][+-]?/.exec(source);
  if (!match) return null;
  return `${match[1]}[!${type}]${fold}${source.slice(match[0].length)}`;
}
