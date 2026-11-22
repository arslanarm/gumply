/**
 * Editing columns (spec/columns §3, #d93qerr7): make a row, add a column by
 * dropping a block on another block's side, move blocks between columns,
 * remove a column a move emptied, dissolve a row left with one column.
 */
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BLOCK_MOVE_META, type BlockRef } from "../../lib/blocks.js";
import { columnShares } from "./markdown.js";

export const MAX_COLUMNS = 5;

const types = (schema: Schema) => ({ columns: schema.nodes.columns, column: schema.nodes.column, paragraph: schema.nodes.paragraph });

/** The column a position is directly inside (its depth), or null. */
export function columnDepthAt(state: EditorState, pos: number): number | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "column") return depth;
  }
  return null;
}

function isEmptyColumn(column: PMNode): boolean {
  return column.childCount === 1 && column.firstChild!.type.name === "paragraph" && column.firstChild!.content.size === 0;
}

/** A new row of `count` columns at the top-level block the caret is in; the block's content goes in the first. */
export function insertColumns(state: EditorState, count: number): Transaction | null {
  const { columns, column, paragraph } = types(state.schema);
  if (!columns || !column || !paragraph) return null;
  const $from = state.selection.$from;
  if ($from.depth !== 1 || !$from.parent.isTextblock) return null;
  const block = $from.parent;
  const first = block.content.size > 0 ? block : paragraph.create();
  const cells = Array.from({ length: Math.max(2, Math.min(MAX_COLUMNS, count)) }, (_, index) =>
    column.create(null, index === 0 ? first : paragraph.create()),
  );
  const pos = $from.before(1);
  const tr = state.tr.replaceWith(pos, pos + block.nodeSize, columns.create(null, cells));
  // The caret where it was, now in the first column.
  const offset = $from.parentOffset;
  tr.setSelection(TextSelection.create(tr.doc, pos + 3 + Math.min(offset, first.content.size)));
  return tr.scrollIntoView();
}

/**
 * Top-level blocks in a row, one per column (Turn into → Columns): the blocks
 * the selection covers, or `block` and an empty column next to it.
 */
export function turnIntoColumns(state: EditorState, block: BlockRef): Transaction | null {
  const { columns, column, paragraph } = types(state.schema);
  if (!columns || !column || !paragraph || block.depth !== 1 || block.node.type === columns) return null;
  const { from, to } = state.selection;
  const covered: { node: PMNode; pos: number }[] = [];
  state.doc.forEach((node, pos) => {
    if (pos + node.nodeSize > from && pos < to && node.type !== columns) covered.push({ node, pos });
  });
  const blocks = covered.length > 1 && covered.some((item) => item.pos === block.from) ? covered.slice(0, MAX_COLUMNS) : [{ node: block.node, pos: block.from }];
  const cells = blocks.map((item) => column.create(null, item.node));
  if (cells.length === 1) cells.push(column.create(null, paragraph.create()));
  const start = blocks[0]!.pos;
  const last = blocks[blocks.length - 1]!;
  // Only contiguous blocks: anything between them (a row) would be lost otherwise.
  const end = last.pos + last.node.nodeSize;
  let between = 0;
  state.doc.nodesBetween(start, end, (node, pos) => {
    if (pos >= start && pos < end && state.doc.resolve(pos).depth === 0) between += 1;
    return false;
  });
  if (between !== blocks.length) return null;
  const tr = state.tr.replaceWith(start, end, columns.create(null, cells));
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + 3)));
  return tr.scrollIntoView();
}

/**
 * Drop `source` beside `target` (spec/columns: drag a block to another block's
 * side edge). A top-level target becomes a two-column row with the source; a
 * target inside a column gets a new column next to its own.
 */
export function dropBeside(state: EditorState, source: BlockRef, target: BlockRef, side: "left" | "right"): Transaction | null {
  const { columns, column } = types(state.schema);
  if (!columns || !column) return null;
  if (source.from === target.from) return null;
  if (source.from <= target.from && source.to >= target.to) return null;
  if (source.node.type.name === "listItem" || source.node.type.name === "taskItem") return null;
  const $target = state.doc.resolve(target.from);
  const inColumn = $target.parent.type === column;
  if (!inColumn && $target.depth !== 0) return null;
  if (target.node.type === columns) return null;
  // No rows inside rows.
  if (source.node.type === columns && inColumn) return null;

  const tr = state.tr;
  if (inColumn) {
    const row = $target.node($target.depth - 1);
    const sourceInSameRow = source.from > $target.before($target.depth - 1) && source.to < $target.after($target.depth - 1);
    if (row.childCount >= MAX_COLUMNS && !sourceInSameRow) return null;
    const columnPos = side === "left" ? $target.before($target.depth) : $target.after($target.depth);
    tr.delete(source.from, source.to);
    const at = tr.mapping.map(columnPos, side === "left" ? -1 : 1);
    tr.insert(at, column.create(null, source.node));
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
  } else {
    if (source.node.type === columns) return null;
    tr.delete(source.from, source.to);
    const from = tr.mapping.map(target.from, 1);
    const to = tr.mapping.map(target.to, -1);
    const targetNode = tr.doc.nodeAt(from);
    if (!targetNode || from + targetNode.nodeSize !== to) return null;
    const pair = [column.create(null, source.node), column.create(null, targetNode)];
    tr.replaceWith(from, to, columns.create(null, side === "left" ? pair : pair.reverse()));
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + (side === "left" ? 3 : 3 + pair[0]!.nodeSize))));
  }
  tr.setMeta(BLOCK_MOVE_META, true);
  return tr.scrollIntoView();
}

/** Move the block the caret is in to the start of the next column, or the end of the previous one. */
export function moveToColumn(state: EditorState, direction: "left" | "right"): Transaction | null {
  const depth = columnDepthAt(state, state.selection.from);
  if (depth === null) return null;
  const $from = state.selection.$from;
  const row = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const next = direction === "right" ? index + 1 : index - 1;
  if (next < 0 || next >= row.childCount) return null;
  const blockFrom = $from.before(depth + 1);
  const block = $from.node(depth + 1);
  const offset = state.selection.from - blockFrom;
  const tr = state.tr;
  // Where the block goes, in the old document.
  let columnStart = $from.before(depth - 1) + 1;
  for (let i = 0; i < next; i += 1) columnStart += row.child(i).nodeSize;
  const target = direction === "right" ? columnStart + 1 : columnStart + row.child(next).nodeSize - 1;
  tr.delete(blockFrom, blockFrom + block.nodeSize);
  const at = tr.mapping.map(target, direction === "right" ? 1 : -1);
  // A move out of a column whose only block it was leaves an empty paragraph; the plugin removes that column.
  tr.insert(at, block);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + Math.max(1, Math.min(offset, block.nodeSize - 1)))));
  tr.setMeta(BLOCK_MOVE_META, true);
  return tr.scrollIntoView();
}

/**
 * The columns' widths, as node decorations (`flex: <share> 1 0`), so a
 * column without a width shares what the set widths leave (40% next to a
 * bare column is 40/60). Rows without any width get none: equal parts.
 */
const layoutKey = new PluginKey<DecorationSet>("gumplyColumnsLayout");

/**
 * #9j9cd5x4: while a gutter is dragged, the row at `pos` is laid out in
 * `shares` (percent) so its columns reflow live. Set on a transaction that
 * doesn't change the document (nothing is saved, nothing enters undo); `null`
 * ends the preview, and so does any change to the document (the release
 * writes the widths).
 */
export const COLUMNS_PREVIEW_META = "gumplyColumnsPreview";
export interface ColumnsPreview {
  pos: number;
  shares: number[];
}

export const columnsLayout: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  key: layoutKey,
  state: {
    init: (_config, state) => layoutDecorations(state.doc),
    apply: (tr, previous) => {
      const preview = tr.getMeta(COLUMNS_PREVIEW_META) as ColumnsPreview | null | undefined;
      if (preview !== undefined && !tr.docChanged) return layoutDecorations(tr.doc, preview);
      return tr.docChanged ? layoutDecorations(tr.doc) : previous;
    },
  },
  props: {
    decorations(state): DecorationSet | undefined {
      return layoutKey.getState(state);
    },
  },
});

function layoutDecorations(doc: PMNode, preview: ColumnsPreview | null = null): DecorationSet {
  const decorations: Decoration[] = [];
  const visit = (parent: PMNode, start: number) => {
    parent.forEach((node, offset) => {
      if (node.type.name !== "columns") return;
      const pos = start + offset;
      const widths: Array<number | null> = [];
      node.forEach((column) => widths.push(typeof column.attrs.width === "number" ? column.attrs.width : null));
      const previewed = preview !== null && preview.pos === pos && preview.shares.length === node.childCount;
      const sized = previewed || widths.some((width) => width !== null);
      const shares = previewed ? preview.shares : columnShares(widths);
      let columnPos = pos + 1;
      node.forEach((column, _offset, index) => {
        if (sized) decorations.push(Decoration.node(columnPos, columnPos + column.nodeSize, { style: `flex: ${shares[index]} 1 0` }));
        // Rows inside a column (kept from a file) get theirs too.
        visit(column, columnPos + 1);
        columnPos += column.nodeSize;
      });
    });
  };
  visit(doc, 0);
  return DecorationSet.create(doc, decorations);
}

/**
 * After a change: a column a block move emptied goes (its row shares the
 * room), and a row the change left with one column dissolves into its
 * blocks. Only rows and columns this transaction changed that way: a file
 * that holds a one-column row or an empty column opens and saves as written.
 */
export const columnsCleanup = new Plugin({
  key: new PluginKey("gumplyColumnsCleanup"),
  appendTransaction(transactions, oldState, newState) {
    const changed = transactions.filter((tr) => tr.docChanged);
    if (changed.length === 0) return null;
    const moved = changed.some((tr) => tr.getMeta(BLOCK_MOVE_META));
    const { columns } = types(newState.schema);
    if (!columns) return null;
    // Map positions in the new document back to the old one.
    const back = (pos: number) => {
      let mapped = pos;
      for (let i = changed.length - 1; i >= 0; i -= 1) mapped = changed[i]!.mapping.invert().map(mapped);
      return mapped;
    };
    // 1. Columns a move emptied (they weren't empty before it).
    const emptied: number[] = [];
    if (moved) {
      newState.doc.descendants((node, pos) => {
        if (node.type !== columns) return true;
        node.forEach((column, offset) => {
          if (!isEmptyColumn(column) || node.childCount < 2) return;
          const before = oldState.doc.nodeAt(back(pos + 1 + offset));
          if (!before || before.type !== column.type || !isEmptyColumn(before)) emptied.push(pos + 1 + offset);
        });
        return true;
      });
    }
    const tr = newState.tr;
    for (const pos of emptied.sort((a, b) => b - a)) {
      const node = tr.doc.nodeAt(pos);
      if (node) tr.delete(pos, pos + node.nodeSize);
    }
    // 2. Rows now down to one column that had more before: back to plain blocks.
    const toOld = (pos: number) => back(tr.mapping.invert().map(pos));
    const dissolve: number[] = [];
    tr.doc.descendants((node, pos) => {
      if (node.type !== columns) return true;
      if (node.childCount === 1) {
        const old = oldState.doc.nodeAt(toOld(pos));
        if (old && old.type === columns && old.childCount > 1) dissolve.push(pos);
      }
      return true;
    });
    for (const pos of dissolve.sort((a, b) => b - a)) {
      const row = tr.doc.nodeAt(pos);
      if (row && row.type === columns && row.childCount === 1) tr.replaceWith(pos, pos + row.nodeSize, row.firstChild!.content);
    }
    return tr.docChanged ? tr : null;
  },
});
