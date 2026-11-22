/**
 * Keep each block's own Markdown markup across an edit (#82x82ek7):
 * `*` / `+` / `-` bullets per list, `1)` vs `1.` ordered lists, `***` / `___`
 * rules and setext (`Title\n=====`) headings. Without this, one edit
 * rewrote them all to the editor's defaults, and a `+` list right after a
 * `*` list was merged into it (CommonMark keeps them apart).
 *
 * markdown-it records the markup on its tokens; a core rule copies it to a
 * `data-md-markup` attribute, which the nodes below keep as `markdownMarkup`.
 */
import { Extension } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import OrderedList from "@tiptap/extension-ordered-list";
import type { Node as PMNode } from "@tiptap/pm/model";
import { recordedNumbers } from "./list-source.js";
import { separateFromPreviousList } from "./list-style.js";

export const MARKUP_ATTR = "data-md-markup";

const MARKUP_TOKENS = new Set(["bullet_list_open", "ordered_list_open", "hr", "heading_open"]);

/* markdown-it is untyped here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function markupRule(state: any): void {
  let lines: string[] | null = null;
  for (const token of state.tokens as any[]) {
    if (!MARKUP_TOKENS.has(token.type) || !token.markup) continue;
    let markup = String(token.markup);
    // A setext underline keeps its own length (`===` under "Title"), #54prcupx.
    if (token.type === "heading_open" && (markup === "=" || markup === "-") && token.map) {
      lines ??= String(state.src).split("\n");
      const underline = (lines[(token.map[1] as number) - 1] ?? "").trim();
      if (new RegExp(`^\\${markup}+$`).test(underline)) markup = underline;
    }
    // An ATX closing sequence (`## Title ##`) is kept as written, #6rbi25wy:
    // recorded after the opening hashes, e.g. `##` + ` ##`.
    if (token.type === "heading_open" && /^#{1,6}$/.test(markup) && token.map) {
      lines ??= String(state.src).split("\n");
      const line = (lines[token.map[0] as number] ?? "").replace(/^(?:[ \t]*>[ \t]?)*/, "");
      const closing = new RegExp(`^ {0,3}${markup}[ \\t]+\\S.*?([ \\t]+#+[ \\t]*)$`).exec(line);
      if (closing) markup += closing[1];
    }
    token.attrSet(MARKUP_ATTR, markup);
  }
}

/** `markdownMarkup` on every node whose markup we keep. */
export const MarkdownMarkup = Extension.create({
  name: "markdownMarkup",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList", "taskList", "orderedList", "horizontalRule", "heading"],
        attributes: {
          markdownMarkup: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute(MARKUP_ATTR),
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
});

interface MarkupSerializerState {
  write(content?: string): void;
  renderInline(node: PMNode): void;
  closeBlock(node: PMNode): void;
  ensureNewLine(): void;
  repeat(text: string, count: number): string;
  renderList(node: PMNode, delim: string, firstDelim: (index: number) => string): void;
}

/** Ordered-list delimiter: as read, else `.`; never the same as an adjacent list's. */
function orderedSeparator(node: PMNode, parent: PMNode | undefined, index: number): string {
  const own = node.attrs.markdownMarkup === ")" ? ")" : ".";
  const previous = parent && index > 0 ? parent.child(index - 1) : null;
  if (previous?.type === node.type && !node.attrs.markdownMarkup) {
    const before = previous.attrs.markdownMarkup === ")" ? ")" : ".";
    return before === "." ? ")" : ".";
  }
  return own;
}

export const MarkdownOrderedList = OrderedList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkupSerializerState, node: PMNode, parent: PMNode, index: number) {
          const start = Number(node.attrs.start ?? 1) || 1;
          const separator = orderedSeparator(node, parent, index);
          separateFromPreviousList(state as never, node);
          // The numbers as written, if still consistent (#fmmght8w).
          const recorded = recordedNumbers(node, start);
          if (recorded) {
            const widest = Math.max(...recorded.map((number) => number.length));
            state.renderList(node, state.repeat(" ", widest + 2), (i) => `${recorded[i]}${separator} `);
            return;
          }
          const width = String(start + node.childCount - 1).length;
          state.renderList(node, state.repeat(" ", width + 2), (i) => {
            const number = String(start + i);
            return `${state.repeat(" ", width - number.length)}${number}${separator} `;
          });
        },
      },
    };
  },
});

export const MarkdownHorizontalRule = HorizontalRule.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkupSerializerState, node: PMNode) {
          const markup = String(node.attrs.markdownMarkup ?? "");
          state.write(/^(\*{3,}|-{3,}|_{3,})$/.test(markup) ? markup : "---");
          state.closeBlock(node);
        },
      },
    };
  },
});

export const MarkdownHeading = Heading.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkupSerializerState, node: PMNode) {
          const level = Number(node.attrs.level ?? 1);
          const markup = String(node.attrs.markdownMarkup ?? "");
          const setext = (/^=+$/.test(markup) && level === 1) || (/^-+$/.test(markup) && level === 2);
          if (setext && node.textContent.trim().length > 0 && !node.textContent.includes("\n")) {
            state.renderInline(node);
            state.ensureNewLine();
            // The underline exactly as written, even a single `-` or `=`
            // (the parse records the whole underline line).
            state.write(markup);
            state.closeBlock(node);
            return;
          }
          state.write(`${state.repeat("#", level)} `);
          state.renderInline(node);
          // The closing sequence as read (`## Title ##`), while the level is the same (#6rbi25wy).
          const hashes = /^(#{1,6})([ \t]+#+[ \t]*)$/.exec(markup);
          if (hashes && hashes[1]!.length === level && node.textContent.trim().length > 0) state.write(hashes[2]!);
          state.closeBlock(node);
        },
      },
    };
  },
});
