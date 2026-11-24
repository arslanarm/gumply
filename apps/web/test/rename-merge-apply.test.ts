import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { renameMergeTarget, replaceChangedRange } from "../src/editor/rename-merge-apply.js";

/*
 * N10 (#5pgmziyc): after a Keep mine the server kept a rename's link change
 * (`See [[Hub]]` → `See [[Hub renamed]]`) in the text the editor sent. The
 * editor takes it in place: only the changed range, outside the undo history.
 * Run on ProseMirror's Markdown schema (a fenced code block's `params` and an
 * ordered list's `order` stand in for the editor's recorded-source attrs).
 * Its stock serializer escapes `[[`, so a link is written `{Hub}` here; the
 * merge is line-based and doesn't care what the link looks like.
 */
const parse = (markdown: string) => defaultMarkdownParser.parse(markdown);
const write = (state: EditorState) => defaultMarkdownSerializer.serialize(state.doc);

const SENT = ["Intro.", "", "```js", "const a = 1;", "```", "", "See {Hub} for more.", "", "3. third", "4. fourth"].join("\n");
const WRITTEN = SENT.replace("See {Hub} for more.", "See {Hub renamed} for more.");

function editorWith(markdown: string) {
  return EditorState.create({ doc: parse(markdown), plugins: [history()] });
}

/** Apply the server's merge to `state`, whose text is `current`; the new state, or `state` unchanged. */
function apply(state: EditorState, current: string): EditorState {
  const target = renameMergeTarget(SENT, WRITTEN, current);
  const tr = replaceChangedRange(state, parse(target));
  return tr ? state.apply(tr) : state;
}

describe("Keep mine: the rename's link changes come into the editor in place (N10)", () => {
  it("(i) nothing typed since: the editor holds exactly the text written, and saves it byte for byte", () => {
    const state = editorWith(SENT);
    expect(write(state)).toBe(SENT);
    const after = apply(state, SENT);
    expect(write(after)).toBe(WRITTEN);
  });

  it("only the changed range is replaced: the blocks around it are the same nodes, with their attrs", () => {
    const state = editorWith(SENT);
    const after = apply(state, SENT);
    const [intro, code, , list] = [0, 1, 2, 3].map((index) => state.doc.child(index));
    expect(after.doc.child(0)).toBe(intro);
    expect(after.doc.child(1)).toBe(code);
    expect(after.doc.child(1).attrs.params).toBe("js");
    expect(after.doc.child(3)).toBe(list);
    expect(after.doc.child(3).attrs.order).toBe(3);
    expect(after.doc.child(2)).not.toBe(state.doc.child(2));
  });

  it("(ii) typed while it was on its way: the typing stays, and the link line takes the change", () => {
    let state = editorWith(SENT);
    // Type at the end of "Intro."
    state = state.apply(state.tr.insertText(" More words.", 7));
    const current = write(state);
    expect(current).toContain("Intro. More words.");
    const after = apply(state, current);
    expect(write(after)).toBe(WRITTEN.replace("Intro.", "Intro. More words."));
  });

  it("a {Hub} typed on another line, or an edited link line, stays the user's", () => {
    let state = editorWith(SENT);
    state = state.apply(state.tr.insertText(" About a new one: {Hub}.", 7));
    const after = apply(state, write(state));
    expect(write(after)).toContain("Intro. About a new one: {Hub}.");
    expect(write(after)).toContain("See {Hub renamed} for more.");

    let edited = editorWith(SENT);
    const linkLine = SENT.indexOf("See {Hub}");
    expect(linkLine).toBeGreaterThan(0);
    // "for more." → "for much more." on the link line itself.
    const at = findText(edited, "for more.") + "for ".length;
    edited = edited.apply(edited.tr.insertText("much ", at));
    const kept = apply(edited, write(edited));
    expect(write(kept)).toContain("See {Hub} for much more.");
  });

  it("undo after it is the user's own typing, and never brings {Hub} back", () => {
    let state = editorWith(SENT);
    state = state.apply(state.tr.insertText(" typed", 7));
    state = apply(state, write(state));
    expect(write(state)).toContain("{Hub renamed}");
    let undone: EditorState | null = null;
    undo(state, (tr) => {
      undone = state.apply(tr);
    });
    expect(undone).not.toBeNull();
    const text = write(undone!);
    expect(text).not.toContain(" typed");
    expect(text).toContain("See {Hub renamed} for more.");
    expect(text).not.toContain("{Hub}");
  });

  it("the caret elsewhere stays where it was", () => {
    let state = editorWith(SENT);
    const caret = findText(state, "Intro.") + 3;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
    const after = apply(state, SENT);
    expect(after.selection.from).toBe(caret);
  });

  it("nothing to do when the editor already holds the new link", () => {
    const state = editorWith(WRITTEN);
    expect(renameMergeTarget(SENT, WRITTEN, WRITTEN)).toBe(WRITTEN);
    expect(replaceChangedRange(state, parse(WRITTEN))).toBeNull();
  });
});

/** The document position where `text` starts. */
function findText(state: EditorState, text: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const index = node.text!.indexOf(text);
    if (index >= 0) found = pos + index;
    return false;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}
