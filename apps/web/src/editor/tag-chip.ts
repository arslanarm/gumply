/**
 * Inline `#tags` drawn as subtle chips, like Obsidian (#ux5cukze). Only a
 * decoration: the text (and so the Markdown) stays exactly `#tag`. Clicking a
 * chip opens search (Cmd+K) with that tag; with the caret already inside the
 * tag a click just moves the caret, so it stays editable.
 *
 * The same scanner as the tag index (core `findInlineTags`, Obsidian's
 * rules): never in code or URLs, and `#2024` alone isn't a tag.
 */
import { findInlineTags } from "@gumply/core";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

let opener: (tag: string) => void = () => {};

/** The app's "search for this tag" (set by the editor). */
export function setTagOpener(next: (tag: string) => void): void {
  opener = next;
}

/** `[from, to, tag]` for every tag in a text, offsets relative to it. */
export function findTags(text: string): Array<[number, number, string]> {
  return findInlineTags(text).map(({ tag, index }) => [index, index + 1 + tag.length, tag]);
}

/** Chip decorations for one textblock at `pos`. */
function decorateBlock(node: ProseMirrorNode, pos: number, out: Decoration[]): void {
  // Tags never span nodes; join the block's text runs (atoms and code count
  // as a break).
  let text = "";
  const starts: number[] = [];
  node.forEach((child, offset) => {
    const plain = child.isText && !child.marks.some((mark) => mark.type.spec.code);
    for (let i = 0; i < child.nodeSize; i += 1) starts.push(pos + 1 + offset + i);
    text += plain ? (child.text ?? "") : " ".repeat(child.nodeSize);
  });
  if (!text.includes("#")) return;
  for (const [from, to, tag] of findTags(text)) {
    const start = starts[from];
    const end = starts[to - 1];
    if (start === undefined || end === undefined) continue;
    out.push(Decoration.inline(start, end + 1, { class: "tag-chip", "data-tag": tag, "data-testid": "tag-chip" }));
  }
}

/** Visit the textblocks (outside code blocks) overlapping `from`…`to`. */
function eachTextblock(doc: ProseMirrorNode, from: number, to: number, visit: (node: ProseMirrorNode, pos: number) => void) {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    visit(node, pos);
    return false;
  });
}

function decorate(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  eachTextblock(doc, 0, doc.content.size, (node, pos) => decorateBlock(node, pos, decorations));
  return DecorationSet.create(doc, decorations);
}

/**
 * After an edit, only the textblocks the transaction touched are scanned
 * again (a long page stays cheap to type in, #evh35bn7).
 */
function update(tr: Transaction, previous: DecorationSet): DecorationSet {
  let set = previous.map(tr.mapping, tr.doc);
  const ranges: Array<[number, number]> = [];
  tr.mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      // Later steps move earlier ranges: map them to the final document.
      const rest = tr.mapping.slice(index + 1);
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  const doc = tr.doc;
  for (const [rawFrom, rawTo] of ranges) {
    const from = Math.max(0, Math.min(rawFrom, doc.content.size));
    const to = Math.max(from, Math.min(rawTo, doc.content.size));
    const fresh: Decoration[] = [];
    // A block that became code keeps no chips.
    set = set.remove(set.find(from, to));
    eachTextblock(doc, from, to, (node, pos) => {
      set = set.remove(set.find(pos, pos + node.nodeSize));
      decorateBlock(node, pos, fresh);
    });
    if (fresh.length > 0) set = set.add(doc, fresh);
  }
  return set;
}

const key = new PluginKey<DecorationSet>("tagChips");

/** The caret was inside the pressed chip before the click (see mousedown). */
let pressedWhileEditing = false;

export const TagChips = Extension.create({
  name: "tagChips",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, previous) => (tr.docChanged ? update(tr, previous) : previous),
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            // The browser moves the caret on mousedown, before the click: note
            // whether it was already in this tag (then the click edits it).
            mousedown(view, event) {
              pressedWhileEditing = false;
              const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>(".tag-chip");
              const tag = chip?.dataset.tag;
              if (!chip || !tag || !view.hasFocus()) return false;
              const { from, to } = view.state.selection;
              const start = view.posAtDOM(chip, 0);
              pressedWhileEditing = from === to && from >= start && from <= start + tag.length + 1;
              return false;
            },
          },
          handleClick(_view, _pos, event) {
            if (event.button !== 0 || event.shiftKey || event.altKey || pressedWhileEditing) return false;
            const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>(".tag-chip");
            const tag = chip?.dataset.tag;
            if (!chip || !tag) return false;
            event.preventDefault();
            opener(tag);
            return true;
          },
        },
      }),
    ];
  },
});
