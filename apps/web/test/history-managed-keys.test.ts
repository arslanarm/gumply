import { describe, expect, it } from "vitest";
import type { DiffLineView } from "../src/components/LineDiffView";
import { hideManagedKeyChanges } from "../src/lib/history-diff";

const same = (text: string): DiffLineView => ({ op: "same", text });
const add = (text: string): DiffLineView => ({ op: "add", text });
const remove = (text: string): DiffLineView => ({ op: "remove", text });
const changed = (lines: DiffLineView[]) => lines.some((line) => line.op !== "same");

describe("History Changes hide Gumply's own frontmatter keys (#h4tyk92t)", () => {
  it("a version that differs only in updated: shows no changes, at the current value", () => {
    const lines = [same("---"), same("created: 2026-11-01T10:00:00Z"), remove("updated: 2026-11-20T09:00:00Z"), add("updated: 2026-11-23T09:00:00Z"), same("---"), same(""), same("Body.")];
    const shown = hideManagedKeyChanges(lines);
    expect(changed(shown)).toBe(false);
    expect(shown.map((line) => line.text)).toEqual(["---", "created: 2026-11-01T10:00:00Z", "updated: 2026-11-23T09:00:00Z", "---", "", "Body."]);
  });

  it("keeps real changes: the body, other frontmatter keys, and updated: written in the body", () => {
    const lines = [same("---"), remove("updated: a"), add("updated: b"), remove("tags: []"), add("tags: [work]"), same("---"), remove("Old line."), add("New line."), add("updated: in the body")];
    const shown = hideManagedKeyChanges(lines);
    expect(shown.filter((line) => line.op !== "same").map((line) => `${line.op} ${line.text}`)).toEqual([
      "remove tags: []",
      "add tags: [work]",
      "remove Old line.",
      "add New line.",
      "add updated: in the body",
    ]);
  });

  it("a note without frontmatter is unchanged, and the input is never mutated", () => {
    const plain = [remove("updated: not frontmatter"), add("Text.")];
    expect(hideManagedKeyChanges(plain)).toEqual(plain);
    const lines = [same("---"), remove("updated: a"), add("updated: b"), same("---")];
    const copy = structuredClone(lines);
    hideManagedKeyChanges(lines);
    expect(lines).toEqual(copy);
  });
});
