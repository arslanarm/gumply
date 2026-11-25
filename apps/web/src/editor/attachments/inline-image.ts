/**
 * Inline images (#2rmk983y).
 *
 * The image node is a block (Notion-style image with caption). An image that
 * shares its line with text — README badges, inline icons, Obsidian
 * `![[icon.png|16]]` — used to be lifted out of its paragraph, splitting it
 * into three blocks on the next save. Such images are now an inline node and
 * written back exactly where they were. Only an image alone in its paragraph
 * is an image block.
 */
import { subscribeFileLinks } from "../../lib/file-links.js";
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { urlForLink } from "../../lib/attachment-links.js";
import { imageRawAttributes, unchangedImageMarkdown } from "./image-raw.js";
import { altParts } from "./image-width.js";
import { getWikiLinkEnvironment, subscribeWikiLinkEnvironment } from "../wikilink/link-store.js";

export const INLINE_IMAGE_ATTR = "data-inline-image";

const IMAGE_TOKENS = new Set(["image", "attachment_image"]);

/* markdown-it is untyped here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Is this inline child real content (not whitespace or a line break)? */
function isContent(token: any): boolean {
  if (token.type === "softbreak" || token.type === "hardbreak") return false;
  if (token.type === "text") return String(token.content).trim().length > 0;
  return true;
}

/**
 * markdown-it core rule: flag images that share their paragraph with text or
 * other images, so they render as inline images instead of blocks.
 */
export function inlineImageRule(state: any): void {
  for (const block of state.tokens as any[]) {
    if (block.type !== "inline" || !block.children) continue;
    const children = block.children as any[];
    const images = children.filter((token) => IMAGE_TOKENS.has(token.type));
    if (images.length === 0) continue;
    const others = children.some((token) => !IMAGE_TOKENS.has(token.type) && isContent(token));
    if (!others && images.length === 1) continue;
    for (const image of images) image.attrSet(INLINE_IMAGE_ATTR, "1");
  }
}

interface SerializerState {
  write(content?: string): void;
}

/** Obsidian `![[icon.png|16]]` / `|16x16` sizes → width in pixels. */
export function obsidianWidth(obsidian: string | null | undefined): number | null {
  const match = obsidian ? /\|\s*(\d{1,4})(?:\s*x\s*\d{1,4})?\s*\]\]$/.exec(obsidian) : null;
  return match ? Number(match[1]) : null;
}

export const InlineImage = Node.create({
  name: "inlineImage",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("src") ?? "" },
      alt: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("alt") ?? "" },
      title: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("title") ?? "" },
      obsidian: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-obsidian"),
        renderHTML: () => ({}),
      },
      ...imageRawAttributes,
    };
  },

  parseHTML() {
    // Before the image block's `img[src]` rule.
    return [{ tag: `img[${INLINE_IMAGE_ATTR}]`, priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { [INLINE_IMAGE_ATTR]: "1" })];
  },

  addNodeView() {
    return ({ node }) => {
      let current: PMNode = node;
      const dom = document.createElement("img");
      dom.className = "inline-image";
      dom.dataset.testid = "inline-image";
      dom.draggable = false;
      dom.referrerPolicy = "no-referrer";
      const render = () => {
        dom.src =
          urlForLink(String(current.attrs.src), getWikiLinkEnvironment(), "image", current.attrs.obsidian as string | null) ?? "";
        // #e9bd64bb (D46): `![icon|16](x.png)` is 16 px wide, as in Obsidian.
        const fromAlt = altParts(current.attrs);
        dom.alt = fromAlt.text;
        if (current.attrs.title) dom.title = String(current.attrs.title);
        const width = obsidianWidth(current.attrs.obsidian as string | null) ?? fromAlt.width;
        if (width) dom.width = width;
        else dom.removeAttribute("width");
      };
      render();
      const unsubscribeEnv = subscribeWikiLinkEnvironment(render);
      // A link typed after load resolves a moment later (#8k4ssrkb).
      const unsubscribeLinks = subscribeFileLinks(render);
      const unsubscribe = () => {
        unsubscribeEnv();
        unsubscribeLinks();
      };
      return {
        dom,
        update(next: PMNode) {
          if (next.type !== current.type) return false;
          current = next;
          render();
          return true;
        },
        destroy: unsubscribe,
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          if (node.attrs.obsidian) {
            state.write(String(node.attrs.obsidian));
            return;
          }
          const unchanged = unchangedImageMarkdown(node);
          if (unchanged) {
            state.write(unchanged);
            return;
          }
          const src = String(node.attrs.src ?? "");
          const title = String(node.attrs.title ?? "");
          // #e9bd64bb: a size (`icon|16`) stays unescaped after the caption.
          const { text, size } = altParts(node.attrs);
          state.write(
            `![${text.replace(/[[\]\\|]/g, "\\$&")}${size === null ? "" : `|${size}`}](${src.replace(/[()]/g, "\\$&")}${
              title ? ` "${title.replace(/"/g, '\\"')}"` : ""
            })`,
          );
        },
      },
    };
  },
});
