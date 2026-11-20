/**
 * Table actions for the row/column menus (#7witbbun). Each acts on the cell
 * the menu was opened for: the caret is put in that cell first, then the
 * prosemirror-tables command runs.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { TableMap, findTable, moveTableColumn, moveTableRow } from "@tiptap/pm/tables";
import type { Align } from "./table.js";

export interface CellTarget {
  /** A document position inside the cell. */
  pos: number;
  row: number;
  column: number;
}

function inCell(editor: Editor, target: CellTarget) {
  return editor.chain().focus().command(({ tr }) => {
    const pos = Math.min(target.pos, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
    return true;
  });
}

export const addRowBefore = (editor: Editor, t: CellTarget) => inCell(editor, t).addRowBefore().run();
export const addRowAfter = (editor: Editor, t: CellTarget) => inCell(editor, t).addRowAfter().run();
export const addColumnBefore = (editor: Editor, t: CellTarget) => inCell(editor, t).addColumnBefore().run();
export const addColumnAfter = (editor: Editor, t: CellTarget) => inCell(editor, t).addColumnAfter().run();
export const deleteRowAt = (editor: Editor, t: CellTarget) => inCell(editor, t).deleteRow().run();
export const deleteColumnAt = (editor: Editor, t: CellTarget) => inCell(editor, t).deleteColumn().run();
export const deleteTableAt = (editor: Editor, t: CellTarget) => inCell(editor, t).deleteTable().run();
export const toggleHeaderRowAt = (editor: Editor, t: CellTarget) => inCell(editor, t).toggleHeaderRow().run();

function tableSize(editor: Editor, t: CellTarget): { width: number; height: number } | null {
  const table = findTable(editor.state.doc.resolve(Math.min(t.pos, editor.state.doc.content.size)));
  if (!table) return null;
  const map = TableMap.get(table.node);
  return { width: map.width, height: map.height };
}

export function moveRow(editor: Editor, t: CellTarget, delta: -1 | 1): boolean {
  const size = tableSize(editor, t);
  const to = t.row + delta;
  if (!size || to < 0 || to >= size.height) return false;
  // prosemirror-tables locates the rows through the selection: run it in
  // the same chain that puts the caret in the cell.
  return inCell(editor, t)
    .command(({ state, dispatch }) => moveTableRow({ from: t.row, to, select: false })(state, dispatch))
    .run();
}

export function moveColumn(editor: Editor, t: CellTarget, delta: -1 | 1): boolean {
  const size = tableSize(editor, t);
  const to = t.column + delta;
  if (!size || to < 0 || to >= size.width) return false;
  return inCell(editor, t)
    .command(({ state, dispatch }) => moveTableColumn({ from: t.column, to, select: false })(state, dispatch))
    .run();
}

/** Set the alignment of every cell in the column (saved in the GFM alignment row). */
export function alignColumn(editor: Editor, t: CellTarget, align: Exclude<Align, null>): boolean {
  const { state } = editor;
  const table = findTable(state.doc.resolve(Math.min(t.pos, state.doc.content.size)));
  if (!table) return false;
  const map = TableMap.get(table.node);
  if (t.column >= map.width) return false;
  const tr = state.tr;
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row += 1) {
    const offset = map.map[row * map.width + t.column];
    if (offset === undefined || seen.has(offset)) continue;
    seen.add(offset);
    const pos = table.start + offset;
    const cell = tr.doc.nodeAt(pos);
    if (cell) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
  }
  editor.view.dispatch(tr);
  return true;
}
