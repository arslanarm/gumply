/**
 * Moving between the page title and the body like Notion (#d636gdxx).
 *
 * - Enter in the title focuses the body *synchronously*; TipTap's `focus()`
 *   command waits a frame, so fast typing after Enter went to the title.
 * - ArrowUp on the first line of the first block, or Backspace in an empty
 *   first block, goes back to the title.
 */
import { Extension, type Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { MutableRefObject } from "react";

/** Put the caret at the start of the document and focus it right now. */
export function focusStartNow(editor: Editor): void {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView());
  view.focus();
  // A page that is still mounting may re-attach the editor DOM, which drops
  // focus to <body>; take it back then (but never from another control).
  requestAnimationFrame(() => {
    if (editor.isDestroyed) return;
    const active = document.activeElement;
    if (active === null || active === document.body) view.focus();
  });
}

function inFirstTextblock(editor: Editor): boolean {
  const { selection, doc } = editor.state;
  if (!selection.empty) return false;
  const first = Selection.atStart(doc);
  return selection.$from.sameParent(first.$from);
}

export function createExitTopExtension(onExitTop: MutableRefObject<(() => void) | undefined>) {
  return Extension.create({
    name: "exitTop",

    addKeyboardShortcuts() {
      return {
        ArrowUp: ({ editor }) => {
          if (!onExitTop.current || !inFirstTextblock(editor)) return false;
          // Only from the first visual line of that block.
          if (!editor.view.endOfTextblock("up")) return false;
          onExitTop.current();
          return true;
        },
        Backspace: ({ editor }) => {
          if (!onExitTop.current || !inFirstTextblock(editor)) return false;
          const { $from } = editor.state.selection;
          const block = $from.parent;
          if ($from.parentOffset !== 0 || block.content.size !== 0 || block.type.name !== "paragraph") {
            return false;
          }
          // Inside a list item/quote, keep the normal lift behaviour.
          if ($from.depth !== 1) return false;
          const { doc, tr } = editor.state;
          if (doc.childCount > 1) {
            tr.delete($from.before(), $from.after());
            tr.setSelection(TextSelection.atStart(tr.doc));
            editor.view.dispatch(tr);
          }
          onExitTop.current();
          return true;
        },
      };
    },
  });
}
