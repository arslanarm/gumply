/**
 * TipTap nodes for attachments (D19):
 * - `image` is a block (Notion-style image) with a caption input.
 * - `fileAttachment` is an inline card; Markdown `[name](attachments/x.pdf)`.
 * Both serialize to standard Markdown; the observed Obsidian forms are only
 * accepted on read (markdown-it rules in wikilink/markdown-plugin.ts).
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FileAttachmentView } from "../../components/FileAttachmentView.js";
import { ImageBlockView } from "../../components/ImageBlockView.js";

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
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
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
          const alt = String(node.attrs.alt ?? "");
          const title = String(node.attrs.title ?? "");
          const escaped = src.replace(/[()]/g, "\\$&");
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
          const name = String(node.attrs.name ?? path.split("/").pop() ?? path);
          state.write(`[${state.esc(name)}](${path.replace(/[()]/g, "\\$&")})`);
        },
      },
    };
  },
});
