/**
 * `- [ ] ` markdown shortcut. TipTap's bullet-list rule fires on `- ` before
 * the brackets are typed, so the built-in task-item rule never sees the dash
 * and the line stays a bullet with a literal `[ ]` (walkthrough #rsyu8ixx).
 * This rule runs on the `[ ] ` that follows and turns the current bullet into
 * a to-do item, splitting the list around it.
 */
import { Extension, InputRule } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/**
 * The whole block must be the shortcut, so it never fires mid-text. The dash
 * is optional because a bullet-list item keeps it as literal text when the
 * built-in `- ` rule cannot nest another list inside a list item.
 */
const TASK_SHORTCUT = /^\s*(?:[-+*]\s+)?\[([ xX])?\]\s$/;

export interface TaskShortcutParts {
  /** The bullet list the cursor is in. */
  list: ProseMirrorNode;
  taskListType: NodeType;
  taskItemType: NodeType;
  paragraphType: NodeType;
  /** Index of the bullet item that becomes the to-do. */
  index: number;
  checked: boolean;
}

export interface TaskShortcutReplacement {
  /** Nodes that replace the bullet list: optional list, to-do list, optional list. */
  nodes: ProseMirrorNode[];
  /** Where the caret goes, relative to the start of the replaced list. */
  cursorOffset: number;
}

/** Replace one bullet item with a single-item to-do list, keeping siblings. */
export function taskShortcutReplacement({
  list,
  taskListType,
  taskItemType,
  paragraphType,
  index,
  checked,
}: TaskShortcutParts): TaskShortcutReplacement {
  const before: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _offset, childIndex) => {
    if (childIndex < index) before.push(child);
    else if (childIndex > index) after.push(child);
  });

  const nodes: ProseMirrorNode[] = [];
  let cursorOffset = 0;
  if (before.length > 0) {
    const listBefore = list.type.create(list.attrs, before);
    nodes.push(listBefore);
    cursorOffset += listBefore.nodeSize;
  }

  const taskItem = taskItemType.create({ checked }, paragraphType.create());
  const taskList = taskListType.create(null, taskItem);
  nodes.push(taskList);
  // taskList open + taskItem open + paragraph open = start of the empty text.
  cursorOffset += 3;

  if (after.length > 0) nodes.push(list.type.create(list.attrs, after));

  return { nodes, cursorOffset };
}

export const TaskShortcut = Extension.create({
  name: "taskShortcut",
  priority: 1000,

  addInputRules() {
    return [
      new InputRule({
        find: TASK_SHORTCUT,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const itemDepth = $from.depth - 1;
          const listDepth = $from.depth - 2;
          if (itemDepth < 0 || listDepth < 0) return null;

          const list = $from.node(listDepth);
          if (list.type.name !== "bulletList" || $from.node(itemDepth).type.name !== "listItem") {
            return null;
          }

          const { taskList, taskItem, paragraph } = state.schema.nodes;
          if (!taskList || !taskItem || !paragraph) return null;

          const { nodes, cursorOffset } = taskShortcutReplacement({
            list,
            taskListType: taskList,
            taskItemType: taskItem,
            paragraphType: paragraph,
            index: $from.index(listDepth),
            checked: match[1]?.toLowerCase() === "x",
          });

          const listStart = $from.before(listDepth);
          const tr = state.tr;
          tr.replaceWith(listStart, listStart + list.nodeSize, nodes);
          tr.setSelection(TextSelection.near(tr.doc.resolve(listStart + cursorOffset)));
          return;
        },
      }),
    ];
  },
});
