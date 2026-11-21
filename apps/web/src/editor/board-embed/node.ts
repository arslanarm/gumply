/**
 * A board embedded in a page (spec/v0-6 B, D30): a block node that shows a
 * live, read-only view of the board. On disk it is Obsidian's embed,
 * `![[Board.canvas]]`, with an optional height: `![[Board.canvas|480]]`.
 * An untouched embed is written back exactly as it was read.
 */
import { linkTargetFor, type PageMeta } from "@gumply/core";
import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { BOARD_DRAG_MIME } from "../../board/constants.js";
import { BoardEmbedView } from "../../components/BoardEmbedView.js";
import { isBoard, vaultPathOf } from "../../lib/boards.js";
import { getWikiLinkEnvironment } from "../wikilink/link-store.js";
import { boardEmbedMarkdown, boardEmbedMarkdownPlugin } from "./markdown-plugin.js";

/** Node attributes for an embed of `board` (the link form Obsidian resolves too). */
export function boardEmbedAttrs(board: PageMeta, pages: readonly PageMeta[]): { target: string; size: string; raw: string } {
  return { target: linkTargetFor(board, pages).target, size: "", raw: "" };
}

const dropKey = new PluginKey("boardEmbedDrop");

export const BoardEmbed = Node.create({
  name: "boardEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  // Before the wiki link's `[[…]]` input rule, which would otherwise take the
  // `[[Board.canvas]]` part of a typed `![[Board.canvas]]`.
  priority: 110,

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-target") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-target": attributes.target }),
      },
      size: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-size") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-size": attributes.size }),
      },
      /** The embed as read from disk, written back while untouched. */
      raw: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-raw") ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "board-embed" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["board-embed", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BoardEmbedView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /!\[\[([^[\]|#]+?\.canvas)(?:\|(\d{2,4}))?\]\]$/i,
        type: this.type,
        getAttributes: (match) => ({ target: (match[1] ?? "").trim(), size: match[2] ?? "", raw: "" }),
      }),
    ];
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: dropKey,
        props: {
          // A board dragged from the sidebar onto the page embeds it (D30).
          handleDrop(view, event) {
            const path = event.dataTransfer?.getData(BOARD_DRAG_MIME) ?? "";
            if (!/\.canvas$/i.test(path)) return false;
            const { pages } = getWikiLinkEnvironment();
            const board = pages.find((page) => isBoard(page) && vaultPathOf(page) === path);
            if (!board) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!at) return false;
            event.preventDefault();
            const node = type.create(boardEmbedAttrs(board, pages));
            const $pos = view.state.doc.resolve(at.pos);
            // Drop between blocks: after the block under the pointer.
            const insertAt = $pos.depth > 0 ? $pos.after(1) : at.pos;
            view.dispatch(view.state.tr.insert(insertAt, node).scrollIntoView());
            view.focus();
            return true;
          },
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(
            boardEmbedMarkdown({
              target: String(node.attrs.target ?? ""),
              size: String(node.attrs.size ?? ""),
              raw: String(node.attrs.raw ?? ""),
            }),
          );
          state.closeBlock(node);
        },
        parse: {
          setup(md: any) {
            boardEmbedMarkdownPlugin(md);
          },
        },
      },
    };
  },
});
