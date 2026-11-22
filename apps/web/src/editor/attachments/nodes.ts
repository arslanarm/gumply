/**
 * TipTap nodes for attachments (D19):
 * - `image` is a block (Notion-style image) with a caption input.
 * - `fileAttachment` is an inline card; Markdown `[name](attachments/x.pdf)`.
 * Links are kept exactly as written (D23: note-relative, vault-root, or an
 * untouched Obsidian `![[x.png]]` / `[[x.pdf]]`); new ones are note-relative.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FileAttachmentView } from "../../components/FileAttachmentView.js";
import { ImageBlockView } from "../../components/ImageBlockView.js";
import { hrefForAttachment, obsidianVaultPath } from "../../lib/attachment-links.js";
import { imageRawAttributes, unchangedImageMarkdown } from "./image-raw.js";
import { markdownFileLinkPath } from "../wikilink/markdown-plugin.js";

/** Original Obsidian syntax, kept so an untouched embed is written back as-is. */
const OBSIDIAN_ATTR = {
  default: null,
  parseHTML: (element: HTMLElement) => element.getAttribute("data-obsidian"),
  renderHTML: () => ({}),
};

export const ImageBlock = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("src") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ src: attributes.src }),
      },
      alt: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("alt") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ alt: attributes.alt }),
      },
      title: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("title") ?? "",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.title ? { title: attributes.title } : {},
      },
      uploading: { default: false, parseHTML: () => false, renderHTML: () => ({}) },
      uploadId: { default: "", parseHTML: () => "", renderHTML: () => ({}) },
      obsidian: OBSIDIAN_ATTR,
      ...imageRawAttributes,
    };
  },

  parseHTML() {
    // Inline images (text on the same line) are `inlineImage` nodes; this tag
    // also keeps tiptap-markdown from lifting them out of their paragraph.
    return [{ tag: "img[src]:not([data-inline-image])" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageBlockView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const src = String(node.attrs.src ?? "");
          if (src.length === 0) return;
          const unchanged = unchangedImageMarkdown(node);
          if (unchanged) {
            state.write(unchanged);
            state.closeBlock(node);
            return;
          }
          const alt = String(node.attrs.alt ?? "");
          // Untouched Obsidian embed: write it back as it was (D23).
          if (node.attrs.obsidian && alt === "" && !node.attrs.title) {
            state.write(String(node.attrs.obsidian));
            state.closeBlock(node);
            return;
          }
          const title = String(node.attrs.title ?? "");
          // An Obsidian embed that gained a caption becomes standard Markdown,
          // with a note-relative link (its `src` is the vault path).
          // #8k4ssrkb: the file it resolves to, wherever it lives (else the old guess).
          const href = node.attrs.obsidian ? hrefForAttachment(obsidianVaultPath(node.attrs.obsidian as string) ?? src) : src;
          const escaped = href.replace(/[()]/g, "\\$&");
          state.write(
            `![${state.esc(alt)}](${escaped}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`,
          );
          state.closeBlock(node);
        },
      },
    };
  },
});

export const FileAttachment = Node.create({
  name: "fileAttachment",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-path") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-path": attributes.path }),
      },
      name: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-name") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-name": attributes.name }),
      },
      size: {
        default: 0,
        parseHTML: (element: HTMLElement) => Number(element.getAttribute("data-size") ?? 0) || 0,
        renderHTML: () => ({}),
      },
      mime: { default: "", parseHTML: () => "", renderHTML: () => ({}) },
      uploading: { default: false, parseHTML: () => false, renderHTML: () => ({}) },
      uploadId: { default: "", parseHTML: () => "", renderHTML: () => ({}) },
      obsidian: OBSIDIAN_ATTR,
      // #he3ed9uz: `[My label](attachments/x.pdf)` as written, kept while the path is unchanged.
      markdown: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-md-source"),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "file-attachment" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["file-attachment", mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const path = String(node.attrs.path ?? "");
          if (path.length === 0) return;
          if (node.attrs.obsidian) {
            state.write(String(node.attrs.obsidian));
            return;
          }
          const written = node.attrs.markdown ? String(node.attrs.markdown) : "";
          if (written && markdownFileLinkPath(written) === path) {
            state.write(written);
            return;
          }
          const name = String(node.attrs.name ?? path.split("/").pop() ?? path);
          state.write(`[${state.esc(name)}](${path.replace(/[()]/g, "\\$&")})`);
        },
      },
    };
  },
});
