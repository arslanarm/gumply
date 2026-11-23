import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { blockAt, impliedNumber, moveBlockConverting, moveBlockTo, type BlockRef } from "../src/lib/blocks.js";
import { MarkdownListSource, recordedNumbers } from "../src/editor/raw-markdown/list-source.js";

/** #2kafk39m: a drop the block can't make as it is, converted (only the moved block changes). */
const schema = getSchema([StarterKit, TaskList, TaskItem, MarkdownListSource]);
const p = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text));
const li = (text: string, markdownNumber: string | null = null) => schema.nodes.listItem!.create({ markdownNumber }, p(text));
const task = (text: string, checked = false) => schema.nodes.taskItem!.create({ checked }, p(text));
const doc = (...blocks: ProseMirrorNode[]) => schema.node("doc", null, blocks);
const state = (...blocks: ProseMirrorNode[]) => EditorState.create({ schema, doc: doc(...blocks) });
const findBlock = (s: EditorState, text: string): BlockRef => {
  let at = -1;
  s.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
  });
  return blockAt(s.doc, at)!;
};
/** The document as `type: text` lines, lists flattened with their item types. */
const shape = (node: ProseMirrorNode): string[] => {
  const out: string[] = [];
  node.forEach((child) => {
    if (child.isTextblock) out.push(`${child.type.name}: ${child.textContent}`);
    else child.forEach((item) => out.push(`${child.type.name}/${item.type.name}${item.attrs.markdownNumber ? `#${item.attrs.markdownNumber}` : ""}${item.attrs.checked === true ? "[x]" : item.type.name === "taskItem" ? "[ ]" : ""}: ${item.textContent}`));
  });
  return out;
};
const drop = (s: EditorState, text: string, targetPos: number) => {
  const block = findBlock(s, text);
  expect(moveBlockTo(s, block, targetPos), "moveBlockTo refuses it as it is").toBeNull();
  const tr = moveBlockConverting(s, block, targetPos);
  return tr ? shape(tr.doc) : null;
};

describe("a refused drop is converted (#2kafk39m)", () => {
  it("a list item dropped at top level becomes its own one-item list of the same kind", () => {
    const s = state(p("Top"), schema.nodes.bulletList!.create(null, [li("one"), li("two")]), p("End"));
    expect(drop(s, "one", s.doc.content.size)).toEqual(["paragraph: Top", "bulletList/listItem: two", "paragraph: End", "bulletList/listItem: one"]);
    expect(drop(s, "two", 0)).toEqual(["bulletList/listItem: two", "paragraph: Top", "bulletList/listItem: one", "paragraph: End"]);
  });

  it("a task keeps its check; a list's only item takes its emptied list with it", () => {
    const s = state(p("Top"), schema.nodes.taskList!.create(null, [task("done", true)]), p("End"));
    expect(drop(s, "done", 0)).toEqual(["taskList/taskItem[x]: done", "paragraph: Top", "paragraph: End"]);
  });

  it("a paragraph dropped between items becomes an item (a to-do, unchecked, in a task list)", () => {
    const bullets = state(p("Para"), schema.nodes.bulletList!.create(null, [li("a"), li("b")]));
    expect(drop(bullets, "Para", findBlock(bullets, "b").from)).toEqual(["bulletList/listItem: a", "bulletList/listItem: Para", "bulletList/listItem: b"]);
    const tasks = state(p("Para"), schema.nodes.taskList!.create(null, [task("a", true), task("b")]));
    expect(drop(tasks, "Para", findBlock(tasks, "a").to)).toEqual(["taskList/taskItem[x]: a", "taskList/taskItem[ ]: Para", "taskList/taskItem[ ]: b"]);
  });

  it("in a numbered list the paragraph takes the number its neighbours imply; the others keep theirs", () => {
    const list = schema.nodes.orderedList!.create(null, [li("one", "1"), li("two", "2"), li("three", "3")]);
    const s = state(p("Para"), list);
    expect(drop(s, "Para", findBlock(s, "one").to)).toEqual(["orderedList/listItem#1: one", "orderedList/listItem#2: Para", "orderedList/listItem#2: two", "orderedList/listItem#3: three"]);
    expect(drop(s, "Para", findBlock(s, "three").to)).toEqual(["orderedList/listItem#1: one", "orderedList/listItem#2: two", "orderedList/listItem#3: three", "orderedList/listItem#4: Para"]);
    expect(drop(s, "Para", findBlock(s, "one").from)?.[0]).toBe("orderedList/listItem#1: Para");
  });

  it("impliedNumber: all-ones stay ones, padding follows the neighbour, unrecorded lists are left to renumber", () => {
    const ol = (...numbers: Array<string | null>) => schema.nodes.orderedList!.create(null, numbers.map((n, i) => li(`i${i}`, n)));
    expect(impliedNumber(ol("1", "1", "1"), 2)).toBe("1");
    expect(impliedNumber(ol(" 9", "10"), 1)).toBe("10");
    expect(impliedNumber(ol(" 8", " 9"), 2)).toBe("10");
    expect(impliedNumber(ol("1", null), 1)).toBeNull();
  });

  it("recordedNumbers keeps equal neighbours (never falling), so nothing else is renumbered", () => {
    const list = (numbers: string[]) =>
      ({ childCount: numbers.length, forEach: (f: (c: { attrs: { markdownNumber: string } }) => void) => numbers.forEach((markdownNumber) => f({ attrs: { markdownNumber } })) }) as never;
    expect(recordedNumbers(list(["1", "2", "2", "3"]), 1)).toEqual(["1", "2", "2", "3"]);
    expect(recordedNumbers(list(["1", "1", "1"]), 1)).toEqual(["1", "1", "1"]);
    expect(recordedNumbers(list(["2", "1"]), 2)).toBeNull();
  });

  it("anything else into a list is refused (null: the gutter shows no drop)", () => {
    const s = state(schema.nodes.heading!.create({ level: 2 }, schema.text("Head")), schema.nodes.bulletList!.create(null, [li("a"), li("b")]));
    const heading = findBlock(s, "Head");
    const into = findBlock(s, "b").from;
    expect(moveBlockTo(s, heading, into)).toBeNull();
    expect(moveBlockConverting(s, heading, into)).toBeNull();
  });
});
