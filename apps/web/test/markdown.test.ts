import { describe, expect, it } from "vitest";
import { normalizeEditorMarkdown } from "../src/lib/markdown.js";

describe("normalizeEditorMarkdown", () => {
  it("unescapes wikilink brackets written by the serializer", () => {
    expect(normalizeEditorMarkdown("See \\[\\[Gumply\\]\\] now.")).toBe("See [[Gumply]] now.");
  });

  it("keeps aliases and headings intact", () => {
    expect(normalizeEditorMarkdown("\\[\\[Plan|roadmap\\]\\] and \\[\\[Plan#Q3\\]\\]")).toBe(
      "[[Plan|roadmap]] and [[Plan#Q3]]",
    );
  });

  it("leaves single brackets escaped", () => {
    expect(normalizeEditorMarkdown("array\\[0\\] and \\[text\\](url)")).toBe(
      "array\\[0\\] and \\[text\\](url)",
    );
  });

  it("leaves ordinary markdown untouched", () => {
    const markdown = "# Title\n\n- one\n\n```\n[[not a link]]\n```\n";
    expect(normalizeEditorMarkdown(markdown)).toBe(markdown);
  });
});
