import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { ImageBlock } from "../src/editor/attachments/nodes.js";
import { InlineImage } from "../src/editor/attachments/inline-image.js";
import { blockAt, moveBlockConverting, moveBlockTo } from "../src/lib/blocks.js";
import { MarkdownListSource } from "../src/editor/raw-markdown/list-source.js";

/**
 * #p6i94g2r: ⋮⋮ an image block between list items makes an item holding the image, the way
 * Obsidian writes it (`- ![A](a.png)`: an inline image in the item, #mrh4dsr6); dragged back
 * out of the list, that item is the image block again.
 */
const schema = getSchema([StarterKit, TaskList, TaskItem, MarkdownListSource, ImageBlock, InlineImage]);
const p = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text));
const li = (text: string, markdownNumber: string | null = null) => schema.nodes.listItem!.create({ markdownNumber }, p(text));
const raw = { markdownRaw: "![A](a.png)", markdownRawKey: ["a.png", "A", ""].join("\u0000") };
const image = () => schema.nodes.image!.create({ src: "a.png", alt: "A", ...raw });
const state = (...blocks: ProseMirrorNode[]) => EditorState.create({ schema, doc: schema.node("doc", null, blocks) });

/** Top-level blocks as `type` lines, a list's items as `list/item: content`. */
const shape = (doc: ProseMirrorNode): string[] => {
  const out: string[] = [];
  doc.forEach((child) => {
    if (child.type.name === "image") out.push(`image ${child.attrs.src}`);
    else if (child.isTextblock) out.push(`${child.type.name}: ${child.textContent}`);
    else
      child.forEach((item) => {
        const inline = item.firstChild?.firstChild;
        const body = inline?.type.name === "inlineImage" ? `[inline image ${inline.attrs.src} raw=${inline.attrs.markdownRaw}]` : item.textContent;
        out.push(`${child.type.name}/${item.type.name}${item.attrs.markdownNumber ? `#${item.attrs.markdownNumber}` : ""}: ${body}`);
      });
  });
  return out;
};

/** The position between the first and second item of the first list. */
const betweenItems = (s: EditorState) => {
  let at = -1;
  s.doc.forEach((child, offset) => {
    if (at < 0 && child.type.name.endsWith("List")) at = offset + 1 + child.firstChild!.nodeSize;
  });
  return at;
};

describe("an image block dropped between list items (#p6i94g2r)", () => {
  it("becomes a bullet holding the image inline, keeping its Markdown", () => {
    const s = state(image(), schema.nodes.bulletList!.create(null, [li("one"), li("two")]));
    const block = blockAt(s.doc, 0)!;
    expect(block.node.type.name).toBe("image");
    expect(moveBlockTo(s, block, betweenItems(s)), "refused as it is").toBeNull();
    const tr = moveBlockConverting(s, block, betweenItems(s))!;
    expect(tr).not.toBeNull();
    expect(shape(tr.doc)).toEqual([
      "bulletList/listItem: one",
      "bulletList/listItem: [inline image a.png raw=![A](a.png)]",
      "bulletList/listItem: two",
    ]);
  });

  it("in a numbered list it takes the number its neighbours imply", () => {
    const s = state(image(), schema.nodes.orderedList!.create(null, [li("one", "1"), li("two", "2")]));
    const tr = moveBlockConverting(s, blockAt(s.doc, 0)!, betweenItems(s))!;
    expect(shape(tr.doc)[1]).toBe("orderedList/listItem#2: [inline image a.png raw=![A](a.png)]");
  });

  it("dragged back out of the list, the image item is the image block again", () => {
    const s = state(image(), schema.nodes.bulletList!.create(null, [li("one"), li("two")]), p("End"));
    const into = moveBlockConverting(s, blockAt(s.doc, 0)!, betweenItems(s))!;
    const t = EditorState.create({ schema, doc: into.doc });
    let itemPos = -1;
    t.doc.descendants((node, pos) => {
      if (itemPos < 0 && node.type.name === "inlineImage") itemPos = pos;
    });
    const item = blockAt(t.doc, itemPos)!;
    expect(item.node.type.name).toBe("listItem");
    const out = moveBlockConverting(t, item, t.doc.content.size)!;
    expect(shape(out.doc)).toEqual(["bulletList/listItem: one", "bulletList/listItem: two", "paragraph: End", "image a.png"]);
    expect(out.doc.lastChild!.attrs.markdownRaw).toBe("![A](a.png)");
  });

  it("an item with text and an image stays a one-item list when dragged out (unchanged)", () => {
    const withText = schema.nodes.listItem!.create(null, schema.nodes.paragraph!.create(null, [schema.text("see "), schema.nodes.inlineImage!.create({ src: "a.png" })]));
    const s = state(schema.nodes.bulletList!.create(null, [withText, li("two")]), p("End"));
    const out = moveBlockConverting(s, blockAt(s.doc, 2)!, s.doc.content.size)!;
    expect(shape(out.doc).at(-1)).toBe("bulletList/listItem: see ");
  });
});
