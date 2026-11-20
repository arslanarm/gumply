import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  moveBlockTo,
  type BlockRef,
} from "../src/lib/blocks.js";

const schema = getSchema([StarterKit, TaskList, TaskItem]);

function p(text: string): ProseMirrorNode {
  return schema.nodes.paragraph!.create(null, text.length > 0 ? schema.text(text) : null);
}

function bulletItem(text: string): ProseMirrorNode {
  return schema.nodes.listItem!.create(null, p(text));
}

function bulletList(...items: ProseMirrorNode[]): ProseMirrorNode {
  return schema.nodes.bulletList!.create(null, items);
}

function doc(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return schema.node("doc", null, blocks);
}

function state(...blocks: ProseMirrorNode[]): EditorState {
  return EditorState.create({ schema, doc: doc(...blocks) });
}

function texts(node: ProseMirrorNode): string[] {
  const out: string[] = [];
  node.forEach((child) => {
    if (child.isTextblock) out.push(child.textContent);
    else child.forEach((grandchild) => out.push(grandchild.textContent));
  });
  return out;
}

function at(state: EditorState, pos: number): BlockRef {
  const block = blockAt(state.doc, pos);
  if (!block) throw new Error(`no block at ${pos}`);
  return block;
}

function apply(state: EditorState, tr: ReturnType<typeof moveBlock>): EditorState {
  if (!tr) throw new Error("expected a transaction");
  return state.apply(tr);
}

describe("blockAt", () => {
  it("finds a top-level block", () => {
    const s = state(p("one"), p("two"));
    const block = at(s, 1);
    expect(block.depth).toBe(1);
    expect(block.node.type.name).toBe("paragraph");
    expect(block.node.textContent).toBe("one");
    expect(block.from).toBe(0);
  });

  it("finds the innermost list item, not the list", () => {
    const s = state(bulletList(bulletItem("one"), bulletItem("two")));
    const list = s.doc.child(0);
    const second = list.child(1);
    const secondFrom = 1 + list.child(0).nodeSize;
    const block = at(s, secondFrom + 2);
    expect(block.node).toBe(second);
    expect(block.node.type.name).toBe("listItem");
    expect(block.depth).toBe(2);
  });
});

describe("moveBlock", () => {
  it("moves a top-level block up and down", () => {
    const s = state(p("one"), p("two"), p("three"));

    const up = apply(s, moveBlock(s, at(s, 6), "up"));
    expect(texts(up.doc)).toEqual(["two", "one", "three"]);

    const down = apply(s, moveBlock(s, at(s, 6), "down"));
    expect(texts(down.doc)).toEqual(["one", "three", "two"]);
  });

  it("does nothing at the edges", () => {
    const s = state(p("one"), p("two"));
    expect(moveBlock(s, at(s, 1), "up")).toBeNull();
    expect(moveBlock(s, at(s, 9), "down")).toBeNull();
  });

  it("moves a list item inside its list", () => {
    const s = state(bulletList(bulletItem("one"), bulletItem("two")));
    const list = s.doc.child(0);
    const secondFrom = 1 + list.child(0).nodeSize;
    const moved = apply(s, moveBlock(s, at(s, secondFrom + 2), "up"));
    expect(texts(moved.doc.child(0))).toEqual(["two", "one"]);
  });

  it("keeps the caret in the moved block", () => {
    const s = state(p("one"), p("two"), p("three"));
    const moved = apply(s, moveBlock(s, at(s, 6), "down"));
    const block = at(moved, moved.selection.from);
    expect(block.node.textContent).toBe("two");
  });
});

describe("moveBlockTo (drag)", () => {
  it("moves a block after another top-level block", () => {
    const s = state(p("one"), p("two"), p("three"));
    const first = at(s, 1);
    const third = at(s, 11);
    const moved = apply(s, moveBlockTo(s, first, third.to));
    expect(texts(moved.doc)).toEqual(["two", "three", "one"]);
  });

  it("refuses to drop a list item between top-level blocks", () => {
    const s = state(bulletList(bulletItem("one")), p("after"));
    const list = s.doc.child(0);
    const item = at(s, 2);
    const after = at(s, 1 + list.nodeSize + 1);
    expect(moveBlockTo(s, item, after.from)).toBeNull();
  });
});

describe("duplicateBlock", () => {
  it("duplicates a top-level block after itself", () => {
    const s = state(p("one"), p("two"));
    const copy = apply(s, duplicateBlock(s, at(s, 1)));
    expect(texts(copy.doc)).toEqual(["one", "one", "two"]);
  });

  it("duplicates a list item inside its list", () => {
    const s = state(bulletList(bulletItem("one"), bulletItem("two")));
    const copy = apply(s, duplicateBlock(s, at(s, 2)));
    expect(texts(copy.doc.child(0))).toEqual(["one", "one", "two"]);
  });
});

describe("deleteBlock", () => {
  it("deletes a top-level block", () => {
    const s = state(p("one"), p("two"));
    const next = apply(s, deleteBlock(s, at(s, 1)));
    expect(texts(next.doc)).toEqual(["two"]);
  });

  it("deletes an emptied list with its last item", () => {
    const s = state(bulletList(bulletItem("only")), p("after"));
    const next = apply(s, deleteBlock(s, at(s, 2)));
    expect(next.doc.child(0).type.name).toBe("paragraph");
    expect(texts(next.doc)).toEqual(["after"]);
  });

  it("leaves an empty paragraph when deleting the only block", () => {
    const s = state(p("only"));
    const next = apply(s, deleteBlock(s, at(s, 1)));
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type.name).toBe("paragraph");
    expect(next.doc.child(0).textContent).toBe("");
  });
});
