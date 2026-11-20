import { describe, expect, it } from "vitest";
import { rowsToMarkdown } from "../src/editor/paste-table.js";

describe("pasted HTML tables → GFM (#y5iqswjf)", () => {
  it("uses the first row as the header and pads short rows", () => {
    expect(rowsToMarkdown([["A", "B"], ["1", "2"], ["3"]])).toBe(
      "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 |  |",
    );
  });
  it("handles a single row", () => {
    expect(rowsToMarkdown([["Only"]])).toBe("| Only |\n|---|");
  });
});
