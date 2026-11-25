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

  it("a to-do holding only an image keeps its checkbox when dragged out: a one-item task list", () => {
    const done = schema.nodes.taskItem!.create({ checked: true }, schema.nodes.paragraph!.create(null, schema.nodes.inlineImage!.create({ src: "a.png", alt: "A" })));
    const s = state(schema.nodes.taskList!.create(null, [done, schema.nodes.taskItem!.create({ checked: false }, p("two"))]), p("End"));
    const out = moveBlockConverting(s, blockAt(s.doc, 2)!, s.doc.content.size)!;
    const last = out.doc.lastChild!;
    expect(last.type.name).toBe("taskList");
    expect(last.firstChild!.attrs.checked).toBe(true);
    expect(last.firstChild!.firstChild!.firstChild!.type.name).toBe("inlineImage");
  });

  it("an image with a width in its alt isn't put in a list (the drop is refused, its width kept)", () => {
    const sized = schema.nodes.image!.create({ src: "a.png", alt: "A|300", markdownRaw: "![A|300](a.png)", markdownRawKey: ["a.png", "A|300", ""].join("\u0000") });
    const s = state(sized, schema.nodes.bulletList!.create(null, [li("one"), li("two")]));
    expect(moveBlockConverting(s, blockAt(s.doc, 0)!, betweenItems(s))).toBeNull();
  });

  it("an escaped caption ending in |digits isn't put in a list either (it would read as a width)", () => {
    const caption = schema.nodes.image!.create({ src: "a.png", alt: "A|301", altLiteral: true });
    const s = state(caption, schema.nodes.bulletList!.create(null, [li("one"), li("two")]));
    expect(moveBlockConverting(s, blockAt(s.doc, 0)!, betweenItems(s))).toBeNull();
  });

  it("a resized embed goes in and comes back out with its |300 (it lives in the embed's text)", () => {
    const embed = schema.nodes.image!.create({ src: "a.png", alt: "", obsidian: "![[a.png|300]]" });
    const s = state(embed, schema.nodes.bulletList!.create(null, [li("one"), li("two")]), p("End"));
    const into = moveBlockConverting(s, blockAt(s.doc, 0)!, betweenItems(s))!;
    let inline: ProseMirrorNode | null = null;
    let itemPos = -1;
    into.doc.descendants((node, pos) => {
      if (!inline && node.type.name === "inlineImage") {
        inline = node;
        itemPos = pos;
      }
    });
    expect((inline as ProseMirrorNode | null)?.attrs.obsidian).toBe("![[a.png|300]]");
    const t = EditorState.create({ schema, doc: into.doc });
    const out = moveBlockConverting(t, blockAt(t.doc, itemPos)!, t.doc.content.size)!;
    expect(out.doc.lastChild!.type.name).toBe("image");
    expect(out.doc.lastChild!.attrs.obsidian).toBe("![[a.png|300]]");
  });
});
