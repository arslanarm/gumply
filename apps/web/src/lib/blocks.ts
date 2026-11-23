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

  // #e9bd64bb (#n6cy66ib): a block atom (an image, a divider, an embed) has no
  // inside; a position over it is the one right before it. It's the block too.
  const after = $pos.nodeAfter;
  if (after && after.isBlock && after.isAtom) {
    return { from: clamped, to: clamped + after.nodeSize, node: after, depth: $pos.depth + 1 };
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

/**
 * #2kafk39m: a drop `moveBlockTo` refuses because the block can't stand there as it is, converted
 * the way Notion does, changing only the moved block's lines (D37):
 * - a list item dropped where a list item can't go (top level, a column, a callout) becomes its own
 *   one-item list of the same kind, its own lines byte for byte;
 * - a paragraph dropped between the items of a list becomes an item of that list: a to-do (unchecked)
 *   in a task list, else a list item; in a numbered list it takes the number its neighbours imply,
 *   and the other items keep theirs.
 * Anything else (a heading, code, table, image… into a list) is null: the caller shows no drop.
 */
export function moveBlockConverting(
  state: EditorState,
  block: BlockRef,
  targetPos: number,
): Transaction | null {
  if (targetPos >= block.from && targetPos <= block.to) return null;
  const name = block.node.type.name;
  const { parent: sourceParent } = parentInfo(state.doc, block);

  // The range to take out: a list's only item takes its (then empty) list with it.
  let from = block.from;
  let to = block.to;
  if (ITEM_NAMES.has(name) && LIST_NAMES.has(sourceParent.type.name) && sourceParent.childCount === 1) {
    const $before = state.doc.resolve(block.from);
    from = $before.before($before.depth);
    to = $before.after($before.depth);
    if (targetPos >= from && targetPos <= to) return null;
  }

  const tr = state.tr.delete(from, to);
  const mapped = tr.mapping.map(targetPos, targetPos > to ? -1 : 1);
  const $target = tr.doc.resolve(mapped);
  const at = $target.index();
  const into = $target.parent;

  let node: ProseMirrorNode | null = null;
  if (ITEM_NAMES.has(name) && LIST_NAMES.has(sourceParent.type.name) && !LIST_NAMES.has(into.type.name)) {
    // A list item out of its list: its own one-item list of the same kind.
    const list = sourceParent.type.createAndFill(null, block.node);
    if (list && into.canReplaceWith(at, at, list.type)) node = list;
  } else if (name === "paragraph" && LIST_NAMES.has(into.type.name)) {
    const itemType = into.type.name === "taskList" ? state.schema.nodes.taskItem : state.schema.nodes.listItem;
    if (itemType) {
      const attrs: Record<string, unknown> = {};
      if (itemType.name === "taskItem") attrs.checked = false;
      if (into.type.name === "orderedList") {
        const number = impliedNumber(into, at);
        if (number !== null) attrs.markdownNumber = number;
      }
      const item = itemType.createAndFill(attrs, block.node);
      if (item && into.canReplaceWith(at, at, item.type)) node = item;
    }
  }
  if (!node) return null;

  tr.insert(mapped, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(mapped + 2, tr.doc.content.size))));
  return keepDocValid(tr, state).setMeta(BLOCK_MOVE_META, true);
}

/**
 * The number a new item at `index` of an ordered list should be written with, so that no other item
 * is renumbered (list-source `recordedNumbers` keeps numbers that never fall): the one before it
 * plus one (never past the one after it), or the first item's own number at the top; all-ones lists
 * stay all ones. Null when the list has no recorded numbers (it is renumbered anyway).
 */
export function impliedNumber(list: ProseMirrorNode, index: number): string | null {
  const numbers: string[] = [];
  list.forEach((child) => {
    if (typeof child.attrs.markdownNumber === "string") numbers.push(child.attrs.markdownNumber);
  });
  if (numbers.length !== list.childCount || numbers.length === 0) return null;
  const values = numbers.map((value) => Number(value.trim()));
  const pad = (n: number, like: string) => {
    const lead = like.length - like.trimStart().length;
    const width = like.trim().length;
    return " ".repeat(Math.max(0, lead + width - String(n).length)) + String(n);
  };
  if (values.every((value) => value === 1)) return pad(1, numbers[0]!);
  if (index === 0) return pad(values[0]!, numbers[0]!);
  const previous = values[index - 1]!;
  let n = previous + 1;
  if (index < values.length && n > values[index]!) n = values[index]!;
  return pad(n, numbers[index - 1]!);
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
