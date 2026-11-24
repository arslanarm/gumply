/**
 * N10 (#5pgmziyc, spec/api v1.35): after a Keep mine the server kept a
 * concurrent rename's link changes on the lines the user didn't touch
 * (`renameLinksMerged`). The open editor still shows the old `[[Old]]`, and
 * its next save would write it back. This brings those changes into the
 * editor in place:
 *
 * - (i) nothing typed since Keep mine was sent: the editor becomes the text
 *   written;
 * - (ii) typed meanwhile: the same line merge applied to the editor's current
 *   text (`mergeRenameLinks(sent, written, current)`), so the typing stays.
 *
 * Only the range that differs is replaced, in one transaction kept out of the
 * undo history: the caret and selection are mapped through it, undo stays the
 * user's own steps (it never brings `[[Old]]` back), and nodes outside the
 * range are the same nodes, so they keep their recorded source (raw Markdown,
 * list markers, table text).
 */
import { createDocument, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { mergeRenameLinks } from "@gumply/core";

/** The text the editor should hold: the text written (i), or the merge applied to newer typing (ii). */
export function renameMergeTarget(sent: string, written: string, current: string): string {
  if (sent === written) return current;
  return current === sent ? written : mergeRenameLinks(sent, written, current).content;
}

/**
 * A transaction that turns `state`'s document into `next` by replacing only the range that
 * differs, kept out of the undo history; null when they're the same.
 */
export function replaceChangedRange(state: EditorState, next: PMNode): Transaction | null {
  const start = state.doc.content.findDiffStart(next.content);
  if (start === null) return null;
  const end = state.doc.content.findDiffEnd(next.content);
  if (!end) return null;
  let endA = end.a;
  let endB = end.b;
  // The two ends can cross when the change repeats nearby text (as in ProseMirror's own DOM diff).
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const tr = state.tr.replace(start, endA, next.slice(start, endB));
  tr.setMeta("addToHistory", false);
  return tr;
}

export interface RenameMergeIo {
  /** The editor's text as it would be saved now. */
  read: (editor: Editor) => string;
  /** Markdown → the editor's HTML input (tiptap-markdown's parser). */
  parse: (editor: Editor, markdown: string) => string;
  /** Called with the parsed document before it is used (table sources and the like). */
  afterParse?: (doc: PMNode) => void;
}

/**
 * Bring the server's merged text into `editor`. `sent` is what the forced save sent, `written`
 * what the server wrote. True when the editor changed.
 */
export function applyMergedRenameLinks(editor: Editor, sent: string, written: string, io: RenameMergeIo): boolean {
  if (editor.isDestroyed) return false;
  const current = io.read(editor);
  const target = renameMergeTarget(sent, written, current);
  if (target === current) return false;
  const next = createDocument(io.parse(editor, target), editor.schema, editor.options.parseOptions);
  io.afterParse?.(next);
  const tr = replaceChangedRange(editor.state, next);
  if (!tr) return false;
  editor.view.dispatch(tr);
  return true;
}
