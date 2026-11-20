/**
 * Insert images and file cards, including upload placeholders (Q1c).
 * Images are block nodes; file cards are inline atoms.
 */
import { hrefForAttachment } from "../../lib/attachment-links.js";
import type { Attachment } from "@gumply/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { BlockRef } from "../../lib/blocks.js";
import { fileNameWithoutExtension } from "../../lib/files.js";

export interface ImageAttrs {
  src: string;
  alt: string;
  title?: string;
  uploading?: boolean;
  uploadId?: string;
}

export interface FileAttrs {
  path: string;
  name: string;
  size?: number;
  mime?: string;
  uploading?: boolean;
  uploadId?: string;
}

interface FoundNode {
  pos: number;
  node: ProseMirrorNode;
}

/** Top-level block containing `pos` (a list counts as one block for images). */
function topLevelBlockAt(doc: ProseMirrorNode, pos: number): BlockRef | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.depth < 1) return null;
  const node = $pos.node(1);
  const from = $pos.before(1);
  return { from, to: from + node.nodeSize, node, depth: 1 };
}

export function findUploadNode(doc: ProseMirrorNode, uploadId: string): FoundNode | null {
  let found: FoundNode | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (String(node.attrs.uploadId ?? "") === uploadId) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

function ensureParagraph(state: EditorState, tr: Transaction): void {
  if (tr.doc.childCount > 0) return;
  const paragraph = state.schema.nodes.paragraph;
  if (paragraph) tr.insert(0, paragraph.create());
}

/** Insert an image block below the top-level block at `pos`. */
export function insertImageBlock(editor: Editor, attrs: ImageAttrs, pos: number): boolean {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return false;

  const image = imageType.create(attrs);
  const tr = state.tr;
  const top = topLevelBlockAt(tr.doc, pos);

  if (!top) {
    tr.insert(Math.min(pos, tr.doc.content.size), image);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + image.nodeSize, tr.doc.content.size))));
  } else if (top.node.type.name === "paragraph" && top.node.textContent.trim().length === 0) {
    tr.replaceWith(top.from, top.to, [image, paragraphType.create()]);
    tr.setSelection(TextSelection.near(tr.doc.resolve(top.from + image.nodeSize + 1)));
  } else {
    const atEnd = top.to >= tr.doc.content.size;
    tr.insert(top.to, atEnd ? [image, paragraphType.create()] : image);
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(top.to + image.nodeSize + (atEnd ? 1 : 0))),
    );
  }

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Insert an inline file card at the nearest text position to `pos`. */
export function insertFileAttachment(editor: Editor, attrs: FileAttrs, pos: number): boolean {
  const { state } = editor;
  const type = state.schema.nodes.fileAttachment;
  if (!type) return false;

  const node = type.create(attrs);
  const tr = state.tr;
  const $pos = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)));

  if ($pos.parent.type.name === "codeBlock") {
    const top = topLevelBlockAt(tr.doc, pos);
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph || !top) return false;
    const wrapped = paragraph.create(null, node);
    tr.insert(top.to, wrapped);
    tr.setSelection(TextSelection.near(tr.doc.resolve(top.to + node.nodeSize)));
  } else {
    const at = TextSelection.near($pos).from;
    tr.insert(at, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + node.nodeSize)));
  }

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export function insertImageAttachment(editor: Editor, attachment: Attachment, pos: number): boolean {
  return insertImageBlock(
    editor,
    { src: hrefForAttachment(attachment.path), alt: fileNameWithoutExtension(attachment.name) },
    pos,
  );
}

export function insertFileCard(editor: Editor, attachment: Attachment, pos: number): boolean {
  return insertFileAttachment(
    editor,
    {
      path: hrefForAttachment(attachment.path),
      name: attachment.name,
      size: attachment.size,
      mime: attachment.mime,
    },
    pos,
  );
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Insert the loading placeholder for a file being uploaded. */
export function insertUploadPlaceholder(
  editor: Editor,
  file: File,
  pos: number,
): { id: string; image: boolean } {
  const id = randomId();
  const image = file.type.startsWith("image/");
  if (image) {
    insertImageBlock(
      editor,
      {
        src: "",
        alt: fileNameWithoutExtension(file.name),
        uploading: true,
        uploadId: id,
      },
      pos,
    );
  } else {
    insertFileAttachment(
      editor,
      {
        path: "",
        name: file.name,
        size: file.size,
        uploading: true,
        uploadId: id,
      },
      pos,
    );
  }
  return { id, image };
}

/** Swap a placeholder for the uploaded attachment. */
export function finishUpload(editor: Editor, uploadId: string, attachment: Attachment): void {
  const found = findUploadNode(editor.state.doc, uploadId);
  if (!found) return;

  const attrs =
    found.node.type.name === "image"
      ? {
          ...found.node.attrs,
          src: hrefForAttachment(attachment.path),
          alt: fileNameWithoutExtension(attachment.name),
          uploading: false,
          uploadId: "",
        }
      : {
          ...found.node.attrs,
          path: hrefForAttachment(attachment.path),
          name: attachment.name,
          size: attachment.size,
          mime: attachment.mime,
          uploading: false,
          uploadId: "",
        };

  editor.view.dispatch(editor.state.tr.setNodeMarkup(found.pos, undefined, attrs));
}

/** Remove a placeholder after a failed upload. */
export function removeUpload(editor: Editor, uploadId: string): void {
  const found = findUploadNode(editor.state.doc, uploadId);
  if (!found) return;
  const tr = editor.state.tr.delete(found.pos, found.pos + found.node.nodeSize);
  ensureParagraph(editor.state, tr);
  editor.view.dispatch(tr);
}
