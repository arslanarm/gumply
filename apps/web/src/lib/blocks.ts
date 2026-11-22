/**
 * Pure block helpers for the Notion-style gutter and block menu
 * (spec/q1-quality §Q1a). A “block” is a top-level document child, or a list
 * item inside a list; the gutter treats both as one row.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export type BlockDirection = "up" | "down";

export interface BlockRef {
  from: number;
  to: number;
  node: ProseMirrorNode;
  /** Depth of the block node in the document (1 = top level). */
  depth: number;
}

const LIST_NAMES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_NAMES = new Set(["listItem", "taskItem"]);

/** Set on transactions that move a block, so a column they empty is removed (spec/columns). */
export const BLOCK_MOVE_META = "gumply:blockMove";

/**
 * The block at `pos`: the innermost list item, else a block directly inside
 * a column (spec/columns), else the top-level block.
 */
export function blockAt(doc: ProseMirrorNode, pos: number): BlockRef | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (ITEM_NAMES.has(node.type.name) || (depth > 1 && $pos.node(depth - 1).type.name === "column")) {
      return { from: $pos.before(depth), to: $pos.after(depth), node, depth };
    }
  }

  if ($pos.depth < 1) return null;
  const node = $pos.node(1);
  return { from: $pos.before(1), to: $pos.before(1) + node.nodeSize, node, depth: 1 };
}

interface ParentInfo {
  parent: ProseMirrorNode;
  index: number;
}

function parentInfo(doc: ProseMirrorNode, block: BlockRef): ParentInfo {
  const $before = doc.resolve(block.from);
  return { parent: $before.parent, index: $before.index($before.depth) };
}

function paragraphType(state: EditorState): ProseMirrorNode | null {
  const paragraph = state.schema.nodes.paragraph;
  return paragraph ? paragraph.create() : null;
}

function keepDocValid(tr: Transaction, state: EditorState): Transaction {
  if (tr.doc.childCount > 0) return tr;
  const empty = paragraphType(state);
  if (empty) tr.insert(0, empty);
  return tr;
}

/** Move a block to an absolute document position (before the node at that pos). */
export function moveBlockTo(
  state: EditorState,
  block: BlockRef,
  targetPos: number,
): Transaction | null {
  if (targetPos >= block.from && targetPos <= block.to) return null;

  const slice = state.doc.slice(block.from, block.to);
  const tr = state.tr.delete(block.from, block.to);
  const mapped = tr.mapping.map(targetPos, targetPos > block.to ? -1 : 1);
  const $target = tr.doc.resolve(mapped);

  if (!$target.parent.canReplaceWith($target.index(), $target.index(), block.node.type)) {
    return null;
  }
  // spec/columns: no rows inside rows.
  if (block.node.type.name === "columns" && $target.parent.type.name === "column") return null;

  const offset = state.selection.from - block.from;
  const inside = Math.max(1, Math.min(offset, block.node.nodeSize - 1));
  tr.replaceWith(mapped, mapped, slice.content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(mapped + inside)));
  return tr.setMeta(BLOCK_MOVE_META, true);
}

/** Move the block one sibling up or down (top level or inside its list). */
export function moveBlock(
  state: EditorState,
  block: BlockRef,
  direction: BlockDirection,
): Transaction | null {
  const { parent, index } = parentInfo(state.doc, block);
  const siblingIndex = direction === "up" ? index - 1 : index + 1;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return null;

  const sibling = parent.child(siblingIndex);
  const targetPos = direction === "up" ? block.from - sibling.nodeSize : block.to + sibling.nodeSize;
  return moveBlockTo(state, block, targetPos);
}

/** Insert a copy of the block directly after it and put the caret in the copy. */
export function duplicateBlock(state: EditorState, block: BlockRef): Transaction | null {
  const copy = block.node.copy(block.node.content);
  const tr = state.tr.insert(block.to, copy);
  const offset = state.selection.from - block.from;
  const inside = Math.max(1, Math.min(offset, block.node.nodeSize - 1));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(block.to + inside)));
}

/** Delete the block; removing a list item also removes an emptied list. */
export function deleteBlock(state: EditorState, block: BlockRef): Transaction | null {
  const { parent } = parentInfo(state.doc, block);

  if (ITEM_NAMES.has(block.node.type.name) && LIST_NAMES.has(parent.type.name) && parent.childCount === 1) {
    const $before = state.doc.resolve(block.from);
    const listFrom = $before.before($before.depth);
    const listTo = $before.after($before.depth);
    const tr = keepDocValid(state.tr.delete(listFrom, listTo), state);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(listFrom, tr.doc.content.size)))));
  }

  if (parent.type.name === "doc" && parent.childCount === 1) {
    const empty = paragraphType(state);
    if (!empty) return null;
    const tr = state.tr.replaceWith(block.from, block.to, empty);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(block.from + 1)));
  }

  const tr = keepDocValid(state.tr.delete(block.from, block.to), state);
  return tr.setSelection(
    TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(block.from, tr.doc.content.size)))),
  );
}
