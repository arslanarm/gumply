/**
 * Indentation inside code blocks (#zyyce7rj), like VS Code / Notion:
 * Tab indents (at the caret, or every selected line), Shift+Tab outdents,
 * Enter keeps the current line's indent. Focus never leaves the editor.
 */
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { findLanguage } from "./languages.js";

/** Languages whose convention is a tab, or two spaces; the rest get four. */
const TAB_LANGUAGES = new Set(["go", "makefile"]);
const TWO_SPACE_LANGUAGES = new Set(["js", "ts", "json", "yaml", "html", "xml", "css", "scss", "ruby", "md", "graphql", "lua"]);

/**
 * The indent to insert: whatever the block already uses (a tab, or its
 * smallest space indent), else the language's convention.
 */
export function indentUnit(text: string, language: string | null | undefined): string {
  let smallest = Infinity;
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) return "\t";
    const spaces = /^( +)\S/.exec(line)?.[1]?.length ?? 0;
    if (spaces > 0 && spaces < smallest) smallest = spaces;
  }
  if (smallest === 2 || smallest === 4) return " ".repeat(smallest);
  const id = findLanguage(language)?.id ?? "";
  if (TAB_LANGUAGES.has(id)) return "\t";
  if (TWO_SPACE_LANGUAGES.has(id)) return "  ";
  return "    ";
}

/** Leading whitespace of the line containing `offset`. */
export function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

/** How much of a line's start one outdent removes. */
export function outdentWidth(line: string, unit: string): number {
  if (line.startsWith("\t")) return 1;
  const spaces = /^ */.exec(line)?.[0].length ?? 0;
  const width = unit === "\t" ? 4 : unit.length;
  return Math.min(spaces, width);
}

interface CodeContext {
  /** Document position of the block's first character. */
  start: number;
  text: string;
  language: string | null;
  from: number;
  to: number;
}

function codeContext(state: EditorState, typeName: string): CodeContext | null {
  const { $from, $to, from, to } = state.selection;
  if ($from.parent.type.name !== typeName || !$from.sameParent($to)) return null;
  const start = $from.start();
  return {
    start,
    text: $from.parent.textContent,
    language: ($from.parent.attrs.language as string | null) ?? null,
    from: from - start,
    to: to - start,
  };
}

/** Offsets of the starts of every line touched by [from, to]. */
function lineStarts(text: string, from: number, to: number): number[] {
  const starts = [text.lastIndexOf("\n", from - 1) + 1];
  for (let i = text.indexOf("\n", from); i !== -1 && i < to; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

export function indentCommand(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, typeName: string): boolean {
  const context = codeContext(state, typeName);
  if (!context) return false;
  if (!dispatch) return true;
  const unit = indentUnit(context.text, context.language);
  const tr = state.tr;
  const multiline = context.text.slice(context.from, context.to).includes("\n");
  if (!multiline) {
    tr.insertText(unit, context.start + context.from, context.start + context.to);
  } else {
    // Indent every selected line; insert from the bottom so offsets hold.
    const starts = lineStarts(context.text, context.from, context.to);
    for (const offset of [...starts].reverse()) tr.insertText(unit, context.start + offset);
    const head = tr.mapping.map(context.start + context.to);
    const anchor = context.start + context.from + unit.length;
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

export function outdentCommand(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, typeName: string): boolean {
  const context = codeContext(state, typeName);
  if (!context) return false;
  // Shift+Tab in code never moves focus, even with nothing to outdent.
  if (!dispatch) return true;
  const unit = indentUnit(context.text, context.language);
  const tr = state.tr;
  const starts = lineStarts(context.text, context.from, context.to);
  for (const offset of [...starts].reverse()) {
    const lineEnd = context.text.indexOf("\n", offset);
    const line = context.text.slice(offset, lineEnd === -1 ? undefined : lineEnd);
    const width = outdentWidth(line, unit);
    if (width > 0) tr.delete(context.start + offset, context.start + offset + width);
  }
  if (tr.docChanged) dispatch(tr.scrollIntoView());
  return true;
}

/** Enter in code: a new line with the current line's indent. */
export function newlineKeepIndent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, typeName: string): boolean {
  const context = codeContext(state, typeName);
  if (!context) return false;
  const indent = lineIndent(context.text, context.from);
  if (!indent) return false; // Plain newline: the default handler (and its triple-Enter exit).
  if (dispatch) {
    dispatch(state.tr.insertText(`\n${indent}`, context.start + context.from, context.start + context.to).scrollIntoView());
  }
  return true;
}
