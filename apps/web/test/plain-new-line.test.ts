import { getExtensionField, type AnyExtension } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { ColorMarks } from "../src/editor/color";
import { Highlight, InnermostCode } from "../src/editor/highlight";
import { MarkdownLink } from "../src/editor/link";
import { PlainSplitBold, PlainSplitItalic, PlainSplitStrike } from "../src/editor/plain-new-line";

/**
 * #hz23dqif: a new line (Enter, a list item's Enter, Shift+Enter) starts plain.
 * TipTap carries a mark over a split unless it says `keepOnSplit: false`
 * (`ExtensionManager.splittableMarks`), so every inline mark the editor
 * registers must say so. The e2e checks the typing on disk.
 */
const keepsOnSplit = (extension: AnyExtension) => getExtensionField<boolean | undefined>(extension, "keepOnSplit") ?? true;

describe("inline marks don't carry over to a new line", () => {
  const marks: AnyExtension[] = [PlainSplitBold, PlainSplitItalic, PlainSplitStrike, InnermostCode, Highlight, ...ColorMarks, MarkdownLink];

  it.each(marks.map((mark) => [mark.name, mark] as const))("%s has keepOnSplit: false", (_name, mark) => {
    expect(keepsOnSplit(mark)).toBe(false);
  });

  it("covers bold, italic, strike, code, highlight, both colours and links", () => {
    expect(marks.map((mark) => mark.name).sort()).toEqual(
      ["backgroundColor", "backgroundColorWrap", "bold", "code", "highlight", "italic", "link", "strike", "textColor", "textColorWrap"].sort(),
    );
  });
});
