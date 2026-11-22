/**
 * Block-level editor commands for the Notion-style gutter/menu (Q1a).
 * The pure document math lives in `lib/blocks.ts`; these wrappers put the
 * caret in the block, apply TipTap commands and keep focus in the editor.
 */
import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
  blockAt,
  duplicateBlock,
  moveBlock,
  type BlockDirection,
  type BlockRef,
} from "../lib/blocks.js";
import { t } from "../i18n/index.js";
import { turnIntoColumns } from "./columns/commands.js";

export type TurnIntoKind =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "ordered"
  | "todo"
  | "quote"
  | "callout"
  | "toggle"
  | "code"
  | "columns";

/** "Turn into" choices, in menu order (block menu, selection toolbar, context menu). */
export const TURN_INTO: ReadonlyArray<{ readonly kind: TurnIntoKind; readonly label: string }> = (
  ["text", "h1", "h2", "h3", "bullet", "ordered", "todo", "quote", "callout", "toggle", "code", "columns"] as const
).map((kind) => ({
  kind,
  // A getter: the label follows the interface language (#7h5utv23).
  get label() {
    return t(`blocks.turnInto.${kind}`);
  },
}));

/** Put the caret at the start of a block so block commands act on it. */
function focusBlock(editor: Editor, block: BlockRef): boolean {
  try {
    const selection = TextSelection.near(editor.state.doc.resolve(block.from + 1));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

function blockAtSelection(editor: Editor): BlockRef | null {
  return blockAt(editor.state.doc, editor.state.selection.from);
}

/** Insert an empty sibling below the block and open the `/` menu in it. */
export function insertBlockBelow(editor: Editor, block: BlockRef): boolean {
  const paragraph = editor.state.schema.nodes.paragraph;
  if (!paragraph) return false;

  const isTask = block.node.type.name === "taskItem";
  const isItem = isTask || block.node.type.name === "listItem";
  const node = isItem
    ? block.node.type.create(isTask ? { checked: false } : null, [paragraph.create()])
    : paragraph.create();

  const tr = editor.state.tr.insert(block.to, node);
  const near = TextSelection.near(tr.doc.resolve(block.to + 1));
  tr.setSelection(near);
  tr.insertText("/", near.from);
  tr.setSelection(TextSelection.create(tr.doc, near.from + 1));
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Notion’s “Turn into”: normalise out of lists/quotes, then apply the type. */
export function turnInto(editor: Editor, block: BlockRef, kind: TurnIntoKind): boolean {
  // spec/columns: the selected top-level blocks (or this one and an empty column) side by side.
  if (kind === "columns") {
    const tr = turnIntoColumns(editor.state, block);
    if (!tr) return false;
    editor.view.dispatch(tr);
    editor.view.focus();
    return true;
  }
  if (!focusBlock(editor, block)) return false;

  const chain = editor.chain().focus().clearNodes();
  switch (kind) {
    case "text":
      chain.setParagraph().run();
      break;
    case "h1":
      chain.setHeading({ level: 1 }).run();
      break;
    case "h2":
      chain.setHeading({ level: 2 }).run();
      break;
    case "h3":
      chain.setHeading({ level: 3 }).run();
      break;
    case "bullet":
      chain.setParagraph().toggleBulletList().run();
      break;
    case "ordered":
      chain.setParagraph().toggleOrderedList().run();
      break;
    case "todo":
      chain.setParagraph().toggleTaskList().run();
      break;
    case "quote":
      chain.setBlockquote().run();
      break;
    case "callout":
      chain.setParagraph().setCallout({ type: "note" }).run();
      break;
    case "toggle":
      chain.setParagraph().setCallout({ type: "note", fold: "-", textInto: "title" }).run();
      break;
    case "code":
      chain.setCodeBlock().run();
      break;
  }
  return true;
}

export function moveBlockFromSelection(editor: Editor, direction: BlockDirection): boolean {
  const block = blockAtSelection(editor);
  if (!block) return false;
  const tr = moveBlock(editor.state, block, direction);
  if (tr) editor.view.dispatch(tr);
  return true;
}

export function duplicateBlockFromSelection(editor: Editor): boolean {
  const block = blockAtSelection(editor);
  if (!block) return false;
  const tr = duplicateBlock(editor.state, block);
  if (tr) editor.view.dispatch(tr);
  return true;
}

/** Cmd/Ctrl+Shift+↑/↓ moves a block; Cmd/Ctrl+D duplicates it. */
export const BlockEditing = Extension.create({
  name: "blockEditing",

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": () => moveBlockFromSelection(this.editor, "up"),
      "Mod-Shift-ArrowDown": () => moveBlockFromSelection(this.editor, "down"),
      "Mod-d": () => duplicateBlockFromSelection(this.editor),
    };
  },
});
