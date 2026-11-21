/**
 * A page preview (#5dpxwac4): a block node that shows a live, read-only view
 * of another page, of one of its sections (`#Heading`) or of one block
 * (`#^id`). On disk it is Obsidian's embed, `![[Page#Heading]]`, written back
 * exactly as it was read while untouched.
 */
import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { PageEmbedView } from "../../components/PageEmbedView.js";
import { pageEmbedMarkdown, pageEmbedMarkdownPlugin, parsePageEmbed } from "./markdown-plugin.js";
import { WIKILINK_INNER } from "@gumply/core";

export const PageEmbed = Node.create({
  name: "pageEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  // Before the wiki link's `[[…]]` input rule (like board embeds).
  priority: 105,

  addAttributes() {
    const attribute = (name: string) => ({
      default: "",
      parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? "",
      renderHTML: (attributes: Record<string, unknown>) => ({ [`data-${name}`]: attributes[name] }),
    });
    return {
      target: attribute("target"),
      part: attribute("part"),
      alias: attribute("alias"),
      /** The embed as read from disk, written back while untouched. */
      raw: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-raw") ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "page-embed" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["page-embed", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PageEmbedView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        // Typed alone in its block: `![[Plan#Goals]]` becomes the preview.
        find: new RegExp(String.raw`^(!\[\[${WIKILINK_INNER}+\]\])$`),
        type: this.type,
        getAttributes: (match) => {
          const meta = parsePageEmbed(match[1] ?? "");
          return meta ? { target: meta.target, part: meta.part, alias: meta.alias, raw: "" } : false;
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          state.write(
            pageEmbedMarkdown({
              target: String(node.attrs.target ?? ""),
              part: String(node.attrs.part ?? ""),
              alias: String(node.attrs.alias ?? ""),
              raw: String(node.attrs.raw ?? ""),
            }),
          );
          state.closeBlock(node);
        },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(md: any) {
            pageEmbedMarkdownPlugin(md);
          },
        },
      },
    };
  },
});
