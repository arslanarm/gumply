/**
 * Markdown shortcuts are applied by ProseMirror input rules in the same
 * transaction as the keystroke that completes them (`# `, `- [ ] `, …).
 * History therefore groups the transform with the typing that produced it, so
 * one undo wipes the block instead of bringing the literal characters back
 * (walkthrough #ihi666yy; `spec/ux` §7). Closing the history group before an
 * input-rule transform makes the transform its own undo step.
 *
 * Runs before the history plugin (priority > 100) so the meta is in place when
 * history records the transaction.
 */
import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";

/** The input-rules plugin tags its transaction with `{ transform, from, to, text }`. */
function isInputRuleTransaction(tr: Transaction, state: EditorState): boolean {
  const inputRules = state.plugins.find((plugin) => plugin.spec.isInputRules);
  return Boolean(inputRules && tr.getMeta(inputRules));
}

export const ShortcutHistory = Extension.create({
  name: "shortcutHistory",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      // With no typing since the shortcut, undo the transform itself: the
      // literal characters (including the trigger space) come back, which is
      // what "undo restores the literal characters" means in `spec/ux` §7.
      "Mod-z": () => this.editor.commands.undoInputRule() || this.editor.commands.undo(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: () => null,
          apply(tr, value, oldState) {
            if (isInputRuleTransaction(tr, oldState)) closeHistory(tr);
            return value;
          },
        },
      }),
    ];
  },
});
