import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { columnShares, columnsMarkdownPlugin, findRow, parseOpenFence } from "../src/editor/columns/markdown.js";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";

const md = new MarkdownIt();
columnsMarkdownPlugin(md);
const types = (source: string) => md.parse(source, {}).filter((token) => token.nesting !== 0).map((token) => token.type);
const rowAt = (source: string, start = 0) => findRow(source.split("\n"), start);

const ROW = ':::: {.columns}\n::: {.column width="40%"}\n### Pros\n- Fast\n:::\n::: {.column width="60%"}\nCons text.\n:::\n::::';

describe("columns: the exact Pandoc form only (spec/columns)", () => {
  it("lays columns out by their widths; bare columns share what's left", () => {
    expect(columnShares([null, null])).toEqual([50, 50]);
    expect(columnShares([40, null])).toEqual([40, 60]);
    expect(columnShares([25, null, null])).toEqual([25, 37.5, 37.5]);
    expect(columnShares([30, 70])).toEqual([30, 70]);
    // Widths that already fill the row: bare columns still get a fair share.
    expect(columnShares([60, 60, null])).toEqual([60, 60, 100 / 3]);
  });

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

describe("display math and comments inside a column (#8uqd657j)", () => {
  const editor = new MarkdownIt();
  columnsMarkdownPlugin(editor);
  rawMarkdownPlugin(editor);
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const rawBlocks = (source: string) =>
    [...editor.render(source).matchAll(/<div data-raw-md="([^"]*)" data-raw-kind="([^"]*)"><\/div>/g)].map((m) => [m[2]!, decode(m[1]!)]);
  const row = (inner: string) => `:::: {.columns}\n::: {.column}\n${inner}\n:::\n::: {.column}\nRight.\n:::\n::::`;

  it("a $$ block on its own lines is a math block, as at the top level", () => {
    expect(rawBlocks(row("$$\n\\sum_i i\n$$"))).toEqual([["math", "$$\n\\sum_i i\n$$"]]);
    expect(rawBlocks("$$\n\\sum_i i\n$$")).toEqual([["math", "$$\n\\sum_i i\n$$"]]);
  });

  it("a $$ block on one line is a math block, not inline math with stray $", () => {
    expect(rawBlocks(row("$$\\sum_i i$$"))).toEqual([["math", "$$\\sum_i i$$"]]);
    expect(editor.render(row("$$\\sum_i i$$"))).not.toContain("data-raw-kind=\"math-inline\"");
  });

  it("next to other blocks, and in a row inside a column", () => {
    expect(rawBlocks(row("Before.\n\n$$\nx^2\n$$\n\nAfter."))).toEqual([["math", "$$\nx^2\n$$"]]);
    const nested = `:::: {.columns}\n::: {.column}\n::::: {.columns}\n:::: {.column}\n$$\ny\n$$\n::::\n:::::\n:::\n::::`;
    expect(rawBlocks(nested)).toEqual([["math", "$$\ny\n$$"]]);
  });

  it("a %% comment in a column stays a comment block", () => {
    expect(rawBlocks(row("%%\nhidden\n%%"))).toEqual([["comment", "%%\nhidden\n%%"]]);
  });

  it("not inside a list or quote in a column (those keep their own rules)", () => {
    expect(rawBlocks(row("- $$x$$"))).toEqual([]);
  });
});
