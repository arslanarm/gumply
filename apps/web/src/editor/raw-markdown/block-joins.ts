/**
 * Keep the absence of a blank line between two blocks (#54prcupx, D37).
 *
 * prosemirror-markdown writes every pair of sibling blocks with one blank
 * line between them. Obsidian notes are full of blocks that touch
 * (`## Heading` ⏎ `Text`, `# Title` ⏎ `- list`, `> quote` ⏎ `## Next`…),
 * so the first edit anywhere in such a note inserted blank lines into lines
 * the user never touched.
 *
 * - **Read:** a markdown-it core rule stamps every block that starts right
 *   under its previous sibling (no blank line between them in the source)
 *   with `data-md-join="<previous kind>><kind>"`. Kinds: `p`, `h`, `quote`
 *   (callouts too), `code`, `table`, `raw`, `hr:<char>`, `ul:<marker>`,
 *   `ol:<delimiter>`. It works at every depth (inside quotes, callouts and
 *   loose list items).
 * - **Keep:** the node attribute `markdownJoin` (never rendered, so copy and
 *   paste don't carry it; not kept on split).
 * - **Write:** while the previous sibling and this block are still the
 *   recorded kinds, the block follows with a single newline. A change that
 *   could alter how the file parses (a heading turned into text, a list
 *   marker changed, an ordered list no longer starting at 1 under text, an
 *   `hr` that would be written `---` under text…) changes a kind, and the
 *   normal blank line comes back. Blocks the user made, split off, pasted or
 *   moved have no recorded join.
 */
import { Extension } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import { MarkdownSerializerState } from "@tiptap/pm/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";

export const JOIN_ATTR = "data-md-join";

/* markdown-it is untyped here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** A `>`-only line inside a quote is blank too. */
const isBlank = (line: string | undefined) => line === undefined || /^[ \t>]*$/.test(line);

/** The kind of a block token, or null for tokens that aren't blocks we track. */
function tokenKind(token: any): string | null {
  switch (token.type) {
    case "paragraph_open":
      return "p";
    case "heading_open":
      return "h";
    case "blockquote_open":
    case "gumply_callout_open":
      return "quote";
    case "fence":
    case "code_block":
      return "code";
    case "table_open":
      return "table";
    case "hr":
      return `hr:${String(token.markup ?? "-").charAt(0)}`;
    case "bullet_list_open":
      return `ul:${token.markup}`;
    case "ordered_list_open":
      return `ol:${token.markup}`;
    case "gumply_raw_block":
    case "html_block":
      return "raw";
    default:
      return null;
  }
}

/** Block-level tokens that start a sibling (list items are their list's own). */
const startsBlock = (token: any) => token.block && token.nesting >= 0 && token.map && token.type !== "list_item_open";

/** #ftx3awn7: a top-level paragraph's first-line indent (0–3 spaces), as read. */
export const INDENT_ATTR = "data-md-indent";
/** #ftx3awn7: a nested quote whose `>` sits right after the outer one (`>>`). */
export const QUOTE_TIGHT_ATTR = "data-md-quote-tight";

/** Positions of the `>` markers at the start of a line (`> >` and `>>` alike). */
function quoteMarkers(line: string): number[] {
  const markers: number[] = [];
  let i = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] !== ">") return markers;
    markers.push(i);
    i += 1;
  }
}

export function blockJoinRule(state: any): void {
  const lines = String(state.src).split("\n");
  // The previous sibling's kind at each nesting level ("" = none yet).
  const previous: string[] = [];
  let quoteDepth = 0;
  for (const token of state.tokens as any[]) {
    if (token.type === "blockquote_close" || token.type === "gumply_callout_close") quoteDepth -= 1;
    if (token.type === "blockquote_open" || token.type === "gumply_callout_open") {
      quoteDepth += 1;
      // `>>`: this quote's marker right after the outer one, no space between.
      if (quoteDepth > 1 && token.type === "blockquote_open" && token.map) {
        const markers = quoteMarkers(lines[token.map[0] as number] ?? "");
        const own = markers[quoteDepth - 1];
        const outer = markers[quoteDepth - 2];
        if (own !== undefined && outer !== undefined && own === outer + 1) token.attrSet(QUOTE_TIGHT_ATTR, "true");
      }
    }
    // An indented first line (`  Text`, up to 3 spaces), top level only.
    if (token.type === "paragraph_open" && token.level === 0 && token.map) {
      const indent = /^( {1,3})\S/.exec(lines[token.map[0] as number] ?? "");
      if (indent) token.attrSet(INDENT_ATTR, indent[1]);
    }
    if (token.nesting === 1) previous[token.level + 1] = "";
    if (!startsBlock(token)) continue;
    const level = token.level as number;
    const kind = tokenKind(token) ?? "?";
    const before = previous[level];
    const first = token.map[0] as number;
    if (before && before !== "?" && kind !== "?" && first > 0 && !isBlank(lines[first - 1])) {
      token.attrSet(JOIN_ATTR, `${before}>${kind}`);
    }
    previous[level] = kind;
    if (token.nesting === 1) previous[level + 1] = "";
  }
}

const JOIN_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "callout",
  "codeBlock",
  "table",
  "horizontalRule",
  "rawBlock",
  "bulletList",
  "taskList",
  "orderedList",
];

/** The kind of an editor block as it would be written now, or null. */
export function nodeKind(node: PMNode): string | null {
  const markup = node.attrs.markdownMarkup as string | null | undefined;
  switch (node.type.name) {
    case "paragraph":
      return node.childCount === 0 ? null : "p";
    case "heading":
      return "h";
    case "blockquote":
    case "callout":
      return "quote";
    case "codeBlock":
      return "code";
    case "table":
      return "table";
    case "horizontalRule":
      return `hr:${/^(\*{3,}|-{3,}|_{3,})$/.test(markup ?? "") ? markup!.charAt(0) : "-"}`;
    case "bulletList":
    case "taskList":
      return markup ? `ul:${markup}` : null;
    case "orderedList":
      return markup === ")" || markup === "." ? `ol:${markup}` : null;
    case "rawBlock":
      return "raw";
    default:
      return null;
  }
}

/** True when `node` was written right under `previous` and still can be. */
export function joinsPrevious(previous: PMNode | null, node: PMNode): boolean {
  const recorded = node.attrs.markdownJoin as string | null | undefined;
  if (!recorded || !previous) return false;
  const before = nodeKind(previous);
  const own = nodeKind(node);
  if (!before || !own || recorded !== `${before}>${own}`) return false;
  // Only `1.` can follow text directly and still be a list.
  if (before === "p" && node.type.name === "orderedList" && Number(node.attrs.start ?? 1) !== 1) return false;
  return true;
}

export const MarkdownBlockJoins = Extension.create({
  name: "markdownBlockJoins",
  addGlobalAttributes() {
    return [
      {
        types: JOIN_TYPES,
        attributes: {
          markdownJoin: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute(JOIN_ATTR) ?? element.firstElementChild?.getAttribute(JOIN_ATTR) ?? null,
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["paragraph"],
        attributes: {
          markdownIndent: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => {
              const value = element.getAttribute(INDENT_ATTR);
              return value && /^ {1,3}$/.test(value) ? value : null;
            },
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["blockquote"],
        attributes: {
          markdownTight: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(QUOTE_TIGHT_ATTR) === "true",
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
});

interface QuoteState {
  delim: string;
  out: string;
  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, f: () => void): void;
  renderContent(node: PMNode): void;
}

/**
 * Blockquotes, with nested markers kept as written (#ftx3awn7): a quote read
 * as `>>` (its `>` right after the outer one) is written `>>`, not `> >`.
 */
export const MarkdownBlockquote = Blockquote.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: QuoteState, node: PMNode) {
          if (!node.attrs.markdownTight || !/>\s*$/.test(state.delim)) {
            state.wrapBlock("> ", null, node, () => state.renderContent(node));
            return;
          }
          const outer = state.delim;
          const tight = outer.replace(/[ \t]+$/, "");
          // The outer quote may already have written its prefix on this line
          // (`>> first` starts the outer quote too): drop its trailing space.
          const lineStart = state.out.lastIndexOf("\n") + 1;
          if (state.out.slice(lineStart) === outer) state.out = state.out.slice(0, lineStart) + tight;
          state.delim = tight;
          state.wrapBlock("> ", null, node, () => state.renderContent(node));
          state.delim = outer;
        },
      },
    };
  },
});

interface JoinState {
  closed: unknown;
  flushClose(size?: number): void;
}

const PATCHED = Symbol.for("gumply.blockJoins");

/**
 * Install the write side once: before a block is rendered, a recorded join
 * replaces the usual blank line with a single newline. tiptap-markdown's
 * state class calls this one through `super.render`.
 */
export function installBlockJoins(): void {
  const proto = MarkdownSerializerState.prototype as unknown as {
    render(node: PMNode, parent: PMNode, index: number): void;
    [PATCHED]?: boolean;
  };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const render = proto.render;
  proto.render = function (this: JoinState, node: PMNode, parent: PMNode, index: number) {
    if (this.closed && parent && index > 0 && node.isBlock && joinsPrevious(parent.child(index - 1), node)) {
      this.flushClose(1);
    }
    render.call(this, node, parent, index);
  };
}

installBlockJoins();
