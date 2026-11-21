import { schema } from "@tiptap/pm/schema-basic";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { findTags, TagChips } from "../src/editor/tag-chip.js";

describe("inline #tag chips (#ux5cukze)", () => {
  it("finds tags like core extractTags does", () => {
    expect(findTags("Plan #design and #q3/launch.")).toEqual([
      [5, 12, "design"],
      [17, 27, "q3/launch"],
    ]);
    expect(findTags("(#a) #ü-ber- x#no #")).toEqual([
      [1, 3, "a"],
      [5, 11, "ü-ber"],
    ]);
    expect(findTags("issue#12 or # heading")).toEqual([]);
  });

  /** The chip ranges of a state, as the text they cover. */
  function chips(state: EditorState): string[] {
    const plugin = state.plugins[0]!;
    const set = plugin.getState(state) as { find: () => Array<{ from: number; to: number }> };
    return set.find().map((deco) => state.doc.textBetween(deco.from, deco.to)).sort();
  }

  function stateOf(...paragraphs: Array<string | ReturnType<typeof schema.node>>) {
    const doc = schema.node(
      "doc",
      null,
      paragraphs.map((item) => (typeof item === "string" ? schema.node("paragraph", null, item ? [schema.text(item)] : []) : item)),
    );
    const plugins = TagChips.config.addProseMirrorPlugins!.call({} as never);
    return EditorState.create({ doc, plugins });
  }

  it("decorates tags, never code, and only changes the text's look", () => {
    const code = schema.node("code_block", null, [schema.text("#not-a-chip")]);
    const marked = schema.node("paragraph", null, [schema.text("#inline", [schema.marks.code.create()]), schema.text(" #yes")]);
    const state = stateOf("Plan #design", code, marked);
    expect(chips(state)).toEqual(["#design", "#yes"]);
  });

  it("stays right while typing (only touched blocks are rescanned)", () => {
    let state = stateOf("Hello #one", "Other #two");
    // Type " #three" at the end of the first paragraph.
    state = state.apply(state.tr.insertText(" #three", 11));
    expect(chips(state)).toEqual(["#one", "#three", "#two"]);
    // Break a tag: "#one" → "# one" (no longer a tag).
    state = state.apply(state.tr.insertText(" ", 8));
    expect(chips(state)).toEqual(["#three", "#two"]);
    // Edits in one block shift the chips of the next one correctly.
    state = state.apply(state.tr.insertText("Intro ", 1));
    expect(chips(state)).toEqual(["#three", "#two"]);
    const second = state.doc.child(1).textContent;
    expect(second).toBe("Other #two");
  });
});
