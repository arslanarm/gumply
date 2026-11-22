import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { columnsMarkdownPlugin, findRow, parseOpenFence } from "../src/editor/columns/markdown.js";

const md = new MarkdownIt();
columnsMarkdownPlugin(md);
const types = (source: string) => md.parse(source, {}).filter((token) => token.nesting !== 0).map((token) => token.type);
const rowAt = (source: string, start = 0) => findRow(source.split("\n"), start);

const ROW = ':::: {.columns}\n::: {.column width="40%"}\n### Pros\n- Fast\n:::\n::: {.column width="60%"}\nCons text.\n:::\n::::';

describe("columns: the exact Pandoc form only (spec/columns)", () => {
  it("reads fence lines", () => {
    expect(parseOpenFence(":::: {.columns}")).toEqual({ colons: 4, classes: ["columns"], width: null });
    expect(parseOpenFence('::: {.column width="40%"}')).toEqual({ colons: 3, classes: ["column"], width: 40 });
    expect(parseOpenFence("::: column")).toEqual({ colons: 3, classes: ["column"], width: null });
    expect(parseOpenFence("::: {.column .wide #id}")?.classes).toEqual(["column", "wide"]);
    expect(parseOpenFence("Text ::: here")).toBeNull();
  });

  it("finds a row with its columns, fences and widths as written", () => {
    const row = rowAt(ROW)!;
    expect(row.open).toBe(":::: {.columns}");
    expect(row.close).toBe("::::");
    expect(row.columns.map((column) => [column.open, column.close, column.width, column.lead, column.trail, column.before])).toEqual([
      ['::: {.column width="40%"}', ":::", 40, 0, 0, 0],
      ['::: {.column width="60%"}', ":::", 60, 0, 0, 0],
    ]);
  });

  it("records the blank lines around fences", () => {
    const row = rowAt(":::: {.columns}\n\n::: {.column}\n\nLeft\n\n:::\n\n\n::: {.column}\nRight\n:::\n\n::::")!;
    expect(row.columns.map((column) => [column.before, column.lead, column.trail])).toEqual([
      [1, 1, 1],
      [2, 0, 0],
    ]);
    expect(row.beforeClose).toBe(1);
  });

  it("keeps fences inside code, and nested generic divs, inside the column", () => {
    const row = rowAt(":::: {.columns}\n::: {.column}\n```\n:::\n```\n::: note\ninner\n:::\n:::\n::: {.column}\nB\n:::\n::::")!;
    expect(row.columns.map((column) => [column.openLine, column.closeLine])).toEqual([
      [1, 8],
      [9, 11],
    ]);
  });

  it("near misses are not columns (they stay as written)", () => {
    for (const source of [
      "::: note\nA note div.\n:::",
      "::: {.column}\nA lone column.\n:::",
      ":::: {.columns}\nUnclosed fence.",
      ":::: {.columns}\nText straight in the row.\n::::",
      ":::: {.columns}\n::: {.column}\nunclosed column\n::::",
      "::: {.columns}\n::: {.column}\nA\n:::\n:::",
      ":::: {.other}\n::: {.column}\nA\n:::\n::::",
      ":::: {.columns}\n::::",
      "```\n:::: {.columns}\n::: {.column}\nA\n:::\n::::\n```",
      "Text\n:::: {.columns}\n::: {.column}\nA\n:::\n::::",
    ]) {
      expect(types(source), source).not.toContain("gumply_columns_open");
    }
  });

  it("parses the blocks inside each column as Markdown", () => {
    expect(types(ROW)).toEqual([
      "gumply_columns_open",
      "gumply_column_open",
      "heading_open",
      "heading_close",
      "bullet_list_open",
      "list_item_open",
      "paragraph_open",
      "paragraph_close",
      "list_item_close",
      "bullet_list_close",
      "gumply_column_close",
      "gumply_column_open",
      "paragraph_open",
      "paragraph_close",
      "gumply_column_close",
      "gumply_columns_close",
    ]);
  });

  it("a row inside a column is read too (kept, never made by the UI)", () => {
    const nested = "::::: {.columns}\n:::: {.column}\n:::: {.columns}\n::: {.column}\nA\n:::\n::::\n::::\n:::: {.column}\nB\n::::\n:::::";
    expect(types(nested).filter((type) => type === "gumply_columns_open")).toHaveLength(2);
  });

  it("a row isn't read inside a quote or a list (left as text there)", () => {
    expect(types("> :::: {.columns}\n> ::: {.column}\n> A\n> :::\n> ::::")).not.toContain("gumply_columns_open");
    expect(types("- :::: {.columns}\n  ::: {.column}\n  A\n  :::\n  ::::")).not.toContain("gumply_columns_open");
  });
});
