/**
 * Ctrl+End / Ctrl+Home reach the very end and start of the page (#k9dwsqxg).
 *
 * The browser's own Ctrl+End only knows text, so it stopped at the last text
 * position and never got past a block with no text inside at the end of the
 * page (an Obsidian `%% comment %%`, a `$$` math block, an image): a line typed
 * after it landed in the middle of the page. When the page ends (or starts)
 * with such a block, the caret becomes a gap cursor after (before) it, where
 * typing or Enter makes a new paragraph. Nothing changes in the document until
 * the user types. A page ending in text keeps the browser's own key.
 */
import { Extension } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";

/** Does the page end (or start) in text the browser's caret can reach? */
function edgeIsText(doc: PMNode, side: "start" | "end"): boolean {
  let node: PMNode | null = doc;
  while (node && !node.isTextblock) {
    if (node.isAtom || node.childCount === 0) return false;
    node = side === "end" ? node.lastChild : node.firstChild;
  }
  return node !== null;
}

/** GapCursor.valid is static in prosemirror-gapcursor but not in its types. */
const gapValid = (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid;

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

export const DocEdgeKeys = Extension.create({
  name: "docEdgeKeys",

  addKeyboardShortcuts() {
    const jump = (side: "start" | "end") => () => {
      const { state, view } = this.editor;
      const { doc } = state;
      if (edgeIsText(doc, side)) return false;
      const $pos = doc.resolve(side === "end" ? doc.content.size : 0);
      if (!gapValid($pos)) return false;
      view.dispatch(state.tr.setSelection(new GapCursor($pos)).scrollIntoView());
      return true;
    };
    return {
      "Mod-End": jump("end"),
      "Mod-Home": jump("start"),
      // On a Mac, Cmd+↓ / Cmd+↑ are the end and start of the document.
      ...(isMac ? { "Mod-ArrowDown": jump("end"), "Mod-ArrowUp": jump("start") } : {}),
    };
  },
});
