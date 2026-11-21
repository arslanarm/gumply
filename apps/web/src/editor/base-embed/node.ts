/**
 * A database view embedded in a page (D34, spec/api-bases): `![[Tasks.base]]`
 * or `![[Tasks.base#Board]]` shows that view live, with `this` = the page.
 */
import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { BaseEmbedView } from "../../components/BaseEmbedView.js";
import { baseEmbedMarkdown, baseEmbedMarkdownPlugin } from "./markdown-plugin.js";

export const BaseEmbed = Node.create({
  name: "baseEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  // Before the wiki link's `[[…]]` input rule (as for board embeds).
  priority: 110,

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-target") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-target": attributes.target }),
      },
      view: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-view") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-view": attributes.view }),
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
    return [{ tag: "base-embed" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["base-embed", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BaseEmbedView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        // Only alone in its block: inside a sentence it stays text + link.
        find: /^!\[\[([^[\]|#]+?\.base)(?:#([^[\]|]*))?\]\]$/i,
        type: this.type,
        getAttributes: (match) => ({ target: (match[1] ?? "").trim(), view: (match[2] ?? "").trim(), raw: "" }),
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(
            baseEmbedMarkdown({
              target: String(node.attrs.target ?? ""),
              view: String(node.attrs.view ?? ""),
              raw: String(node.attrs.raw ?? ""),
            }),
          );
          state.closeBlock(node);
        },
        parse: {
          setup(md: any) {
            baseEmbedMarkdownPlugin(md);
          },
        },
      },
    };
  },
});
