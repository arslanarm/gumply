import { Schema } from "@tiptap/pm/model";
import { defaultMarkdownParser } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import { currentIndex, framesInReadingOrder, hasChildren, headingText, nestLevels, outlineOf, visibleEntries } from "../src/outline/headings.js";

/*
 * CommonMark's parse gives the same top-level heading nodes as the editor's
 * (the pass only looks at the document's direct children); the e2e covers
 * the real editor.
 */
const parse = (markdown: string) => defaultMarkdownParser.parse(markdown);
const list = (markdown: string) => outlineOf(parse(markdown)).map(({ level, text, depth }) => ({ level, text, depth }));

describe("outline: what it lists (spec/outline §2, @opus-hunter's Obsidian table)", () => {
  it("lists top-level ATX h1–h6 and setext headings", () => {
    const md = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSetext one\n===\n\nSetext two\n---\n";
    expect(list(md).map((entry) => [entry.level, entry.text])).toEqual([
      [1, "One"],
      [2, "Two"],
      [3, "Three"],
      [4, "Four"],
      [5, "Five"],
      [6, "Six"],
      [1, "Setext one"],
      [2, "Setext two"],
    ]);
  });

  it("lists `#` alone and `## ` as empty entries", () => {
    expect(list("#\n\ntext\n\n## \n").map((entry) => [entry.level, entry.text])).toEqual([
      [1, ""],
      [2, ""],
    ]);
  });

  it("doesn't list headings in callouts, quotes, list items or code, raw HTML, or non-headings", () => {
    const md = [
      "> [!note] Title",
      "> ## In a callout",
      "",
      "> ## In a quote",
      "",
      "- item",
      "  ## In a list item",
      "  - deeper",
      "    ### Deeper still",
      "",
      "```",
      "# In code",
      "```",
      "",
      "<h2>Raw HTML</h2>",
      "",
      "####### Seven",
      "",
      "#NoSpace",
      "",
      "## The only one",
    ].join("\n");
    expect(list(md)).toEqual([{ level: 2, text: "The only one", depth: 0 }]);
  });

  it("reads marks as plain text and links by their label", () => {
    expect(list("## A **bold** and *it* `code` [link](https://x.y) end\n")[0]!.text).toBe("A bold and it code link end");
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
        text: { group: "inline" },
        wikiLink: { inline: true, group: "inline", atom: true, attrs: { targetTitle: { default: "" }, alias: { default: "" } } },
      },
    });
    const heading = schema.node("heading", { level: 2 }, [
      schema.text("See "),
      schema.node("wikiLink", { targetTitle: "Other page", alias: "" }),
      schema.text(" and "),
      schema.node("wikiLink", { targetTitle: "Other page", alias: "that one" }),
    ]);
    expect(headingText(heading)).toBe("See Other page and that one");
    const doc = schema.node("doc", null, [heading]);
    expect(outlineOf(doc)[0]).toMatchObject({ level: 2, text: "See Other page and that one", pos: 0 });
  });

  it("indents a skipped level one step under its parent", () => {
    expect(nestLevels([1, 3, 3, 2, 4, 1, 2])).toEqual([0, 1, 1, 1, 2, 0, 1]);
    expect(nestLevels([3, 2, 1])).toEqual([0, 0, 0]);
    expect(list("# A\n\n### B\n\n## C\n").map((entry) => entry.depth)).toEqual([0, 1, 1]);
  });

  it("keys survive edits elsewhere; repeated titles stay distinct", () => {
    const before = outlineOf(parse("# A\n\n## Same\n\n## Same\n")).map((entry) => entry.key);
    const after = outlineOf(parse("Intro paragraph.\n\n# A\n\nMore.\n\n## Same\n\n## Same\n")).map((entry) => entry.key);
    expect(after).toEqual(before);
    expect(new Set(before).size).toBe(3);
  });

  it("collapsing hides the entries under it", () => {
    const entries = outlineOf(parse("# A\n\n## A1\n\n### A1a\n\n# B\n\n## B1\n"));
    const keys = entries.map((entry) => entry.key);
    expect(visibleEntries(entries, new Set([keys[0]!])).map((entry) => entry.text)).toEqual(["A", "B", "B1"]);
    expect(visibleEntries(entries, new Set([keys[1]!])).map((entry) => entry.text)).toEqual(["A", "A1", "B", "B1"]);
    expect(entries.map((_, index) => hasChildren(entries, index))).toEqual([true, true, false, true, false]);
  });

  it("the current heading is the last one at or above the line", () => {
    expect(currentIndex([0, 100, 200], -5)).toBe(-1);
    expect(currentIndex([0, 100, 200], 0)).toBe(0);
    expect(currentIndex([0, 100, 200], 150)).toBe(1);
    expect(currentIndex([0, 100, 200], 999)).toBe(2);
  });

  it("board frames read top to bottom, left to right within a row", () => {
    const frame = (id: string, x: number, y: number, height = 200) => ({ id, title: id, x, y, width: 300, height });
    const order = framesInReadingOrder([frame("C", 0, 400), frame("B", 400, 30), frame("A", 0, 0), frame("D", 400, 420)]);
    expect(order.map((entry) => entry.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("grows linearly with the page: 500 vs 5,000 lines (no wall-clock budget)", () => {
    const page = (sections: number) => {
      const lines: string[] = [];
      for (let i = 0; i < sections; i++) lines.push(`## Section ${i}`, "", "Some text with **bold** words.", "", "- a list item");
      return parse(lines.join("\n"));
    };
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    // 20 passes per run, so a run is long enough to measure; the median of 5 runs after a warm-up.
    const time = (doc: ReturnType<typeof parse>) => {
      for (let i = 0; i < 20; i++) outlineOf(doc);
      return median(
        Array.from({ length: 5 }, () => {
          const started = performance.now();
          for (let i = 0; i < 20; i++) outlineOf(doc);
          return performance.now() - started;
        }),
      );
    };
    const small = page(100); // 500 lines
    const large = page(1000); // 5,000 lines
    expect(outlineOf(large)).toHaveLength(1000);
    const ratio = time(large) / Math.max(time(small), 0.05);
    // 10x the lines: a linear pass is ~10x slower, a quadratic one ~100x. The limit sits in between.
    expect(ratio).toBeLessThan(40);
  });
});
