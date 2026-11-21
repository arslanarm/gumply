/**
 * Obsidian block ids in the editor (#5dpxwac4).
 *
 * - **Copy link to block / Copy block embed:** give a block a ` ^abc123` id if
 *   it has none (the only write, on demand) and copy `[[Page#^id]]` or
 *   `![[Page#^id]]`. Text blocks get the id at their end; tables, code,
 *   callouts and quotes get it on a line of their own just after them, which
 *   is where Obsidian puts it.
 * - **Chip:** ` ^id` at a block's end is drawn faintly. It's a decoration only:
 *   the text stays plain, the caret moves through it and Backspace deletes
 *   one character at a time, like any text.
 */
import { newBlockId } from "@gumply/core";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { BlockRef } from "../../lib/blocks.js";

const ID_AT_END = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
/** Blocks whose id goes on its own line after them. */
const OWN_LINE = new Set(["table", "codeBlock", "callout", "blockquote", "rawBlock", "boardEmbed", "pageEmbed", "image", "fileAttachment"]);

/** Every id already in the document (to pick a new, unused one). */
function documentIdText(doc: ProseMirrorNode): string {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      lines.push(node.textContent);
      return false;
    }
    return true;
  });
  return lines.join("\n");
}

/** The last text block inside `node` that isn't code (where an id at the end goes). */
function lastTextblock(node: ProseMirrorNode, pos: number): { node: ProseMirrorNode; pos: number } | null {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  node.descendants((child, offset) => {
    if (child.type.spec.code) return false;
    if (child.isTextblock) {
      found = { node: child, pos: pos + 1 + offset };
      return false;
    }
    return true;
  });
  if (node.isTextblock && !node.type.spec.code) return { node, pos };
  return found;
}

/**
 * The block's id, adding one when it has none. Returns the id, or null when
 * the block can't carry one.
 */
export function ensureBlockId(editor: Editor, block: BlockRef): string | null {
  const { state } = editor;
  const node = block.node;
  // An id already right after an own-line block?
  if (OWN_LINE.has(node.type.name)) {
    const after = state.doc.resolve(block.to).nodeAfter;
    const existing = after?.isTextblock ? /^\s*\^([A-Za-z0-9-]+)\s*$/.exec(after.textContent)?.[1] : undefined;
    if (existing) return existing;
    const id = newBlockId(documentIdText(state.doc));
    const paragraph = state.schema.nodes.paragraph?.create(null, state.schema.text(`^${id}`));
    if (!paragraph) return null;
    editor.view.dispatch(state.tr.insert(block.to, paragraph));
    return id;
  }
  const text = lastTextblock(node, block.from);
  if (!text) return null;
  const existing = ID_AT_END.exec(text.node.textContent)?.[1];
  if (existing) return existing;
  const id = newBlockId(documentIdText(state.doc));
  const end = text.pos + 1 + text.node.content.size;
  const spacer = text.node.textContent.length === 0 || /\s$/.test(text.node.textContent) ? "" : " ";
  editor.view.dispatch(state.tr.insertText(`${spacer}^${id}`, end));
  return id;
}

const chipKey = new PluginKey("blockIdChips");

function decorate(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent;
    const match = /\^[A-Za-z0-9-]+\s*$/.exec(text);
    if (match && (match.index === 0 || /\s/.test(text[match.index - 1] ?? ""))) {
      // Only plain text children: positions map 1:1 to the text.
      let plain = true;
      node.forEach((child) => {
        if (!child.isText) plain = false;
      });
      if (plain) {
        const from = pos + 1 + match.index;
        const to = pos + 1 + match.index + match[0].trimEnd().length;
        decorations.push(Decoration.inline(from, to, { class: "block-id-chip", "data-testid": "block-id-chip" }));
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** The faint ` ^id` chip (decoration only; see the module comment). */
export const BlockIdChips = Extension.create({
  name: "blockIdChips",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: chipKey,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, previous) => (tr.docChanged ? decorate(tr.doc) : previous),
        },
        props: {
          decorations(state) {
            return chipKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});
