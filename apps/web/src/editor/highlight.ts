/**
 * Highlight (#bg3cb83t): Obsidian's `==text==`, an editable mark like bold.
 * Before, `==text==` was a read-only raw atom (#82x82ek7); now it is real
 * text you can edit, apply with the toolbar or Mod+Shift+H, and it is
 * written back as `==text==`, so untouched text stays byte-for-byte.
 *
 * The markdown-it rule follows markdown-it's own `~~` (strikethrough)
 * delimiter algorithm, as the markdown-it-mark plugin does: `==` must be
 * left-flanking to open and right-flanking to close, so `a == b` stays text.
 */
import { Mark, markInputRule, markPasteRule, mergeAttributes } from "@tiptap/core";
import Code from "@tiptap/extension-code";

/**
 * Inline code that can sit inside other marks, as the innermost one (#bg3cb83t).
 *
 * TipTap's code mark excludes every other mark, so `==a `x` b==` (or
 * `**a `x` b**`) lost the outer mark on the code when read, and the next save
 * split it around the code (`==a ==`x`== b==`). Markdown allows code inside
 * emphasis or a highlight, just not marks inside code, so: code coexists with
 * outer marks, and comes last in the schema (lower priority) so it's always
 * opened innermost.
 */
// #hz23dqif: Enter (and Shift+Enter) starts the new line plain, as Notion does.
export const InnermostCode = Code.extend({ priority: 90, excludes: "", keepOnSplit: false });

/* markdown-it is untyped here (see the wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

const EQUALS = 0x3d;

function tokenize(state: any, silent: boolean): boolean {
  const start = state.pos;
  if (silent || state.src.charCodeAt(start) !== EQUALS) return false;

  const scanned = state.scanDelims(state.pos, true);
  let length = scanned.length;
  if (length < 2) return false;

  // An odd run: the first `=` is plain text.
  if (length % 2) {
    const token = state.push("text", "", 0);
    token.content = "=";
    length -= 1;
  }
  for (let i = 0; i < length; i += 2) {
    const token = state.push("text", "", 0);
    token.content = "==";
    state.delimiters.push({
      marker: EQUALS,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += scanned.length;
  return true;
}

function postProcessList(state: any, delimiters: any[]): void {
  const loneMarkers: number[] = [];
  for (const startDelim of delimiters) {
    if (startDelim.marker !== EQUALS || startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];

    const open = state.tokens[startDelim.token];
    open.type = "mark_open";
    open.tag = "mark";
    open.nesting = 1;
    open.markup = "==";
    open.content = "";

    const close = state.tokens[endDelim.token];
    close.type = "mark_close";
    close.tag = "mark";
    close.nesting = -1;
    close.markup = "==";
    close.content = "";

    const previous = state.tokens[endDelim.token - 1];
    if (previous && previous.type === "text" && previous.content === "=") loneMarkers.push(endDelim.token - 1);
  }

  // A lone `=` right before a closing `==` belongs outside it (`===a===`).
  while (loneMarkers.length) {
    const index = loneMarkers.pop()!;
    let j = index + 1;
    while (j < state.tokens.length && state.tokens[j].type === "mark_close") j += 1;
    j -= 1;
    if (index !== j) {
      const token = state.tokens[j];
      state.tokens[j] = state.tokens[index];
      state.tokens[index] = token;
    }
  }
}

function postProcess(state: any): void {
  postProcessList(state, state.delimiters);
  for (const meta of state.tokens_meta ?? []) {
    if (meta?.delimiters) postProcessList(state, meta.delimiters);
  }
}

/** markdown-it: `==text==` → `<mark>text</mark>`. */
export function highlightMarkdownPlugin(md: any): void {
  md.inline.ruler.before("emphasis", "highlight", tokenize);
  md.inline.ruler2.before("emphasis", "highlight", postProcess);
}

export const Highlight = Mark.create({
  name: "highlight",
  // #hz23dqif: Enter (and Shift+Enter) starts the new line plain, as Notion does.
  keepOnSplit: false,

  parseHTML() {
    return [{ tag: "mark" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: "md-highlight" }), 0];
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-h": () => this.editor.commands.toggleMark(this.name),
    };
  },

  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(==(?!\s+==)((?:[^=]+))==(?!\s+==))$/, type: this.type })];
  },

  addPasteRules() {
    return [markPasteRule({ find: /(?:^|\s)(==(?!\s+==)((?:[^=]+))==(?!\s+==))/g, type: this.type })];
  },

  addStorage() {
    return {
      markdown: {
        serialize: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
        parse: {
          setup(md: any) {
            highlightMarkdownPlugin(md);
          },
        },
      },
    };
  },
});
