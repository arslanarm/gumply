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

  it("lists headings inside columns in reading order, left column first (spec/columns)", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "text*", group: "block" },
        heading: { content: "text*", group: "block", attrs: { level: { default: 1 } } },
        blockquote: { content: "block+", group: "block" },
        columns: { content: "column+", group: "block" },
        column: { content: "block+" },
        text: { group: "inline" },
      },
    });
    const h = (level: number, text: string) => schema.node("heading", { level }, [schema.text(text)]);
    const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
    const doc = schema.node("doc", null, [
      h(1, "Top"),
      schema.node("columns", null, [
        schema.node("column", null, [h(2, "Left"), p("a"), schema.node("blockquote", null, [h(2, "Quoted")])]),
        schema.node("column", null, [p("b"), h(3, "Right")]),
      ]),
      h(2, "After"),
    ]);
    const entries = outlineOf(doc);
    expect(entries.map((entry) => entry.text)).toEqual(["Top", "Left", "Right", "After"]);
    // Positions point at the headings themselves (the jump target).
    for (const entry of entries) expect(doc.nodeAt(entry.pos)?.textContent).toBe(entry.text);
  });

  it("board frames read top to bottom, left to right within a row", () => {
    const frame = (id: string, x: number, y: number, height = 200) => ({ id, title: id, x, y, width: 300, height });
    const order = framesInReadingOrder([frame("C", 0, 400), frame("B", 400, 30), frame("A", 0, 0), frame("D", 400, 420)]);
    expect(order.map((entry) => entry.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("grows linearly with the page: 500 vs 5,000 lines (counts node visits, no clock)", () => {
    const page = (sections: number) => {
      const lines: string[] = [];
      for (let i = 0; i < sections; i++) lines.push(`## Section ${i}`, "", "Some text with **bold** words.", "", "- a list item");
      return parse(lines.join("\n"));
    };
    // A work counter, not a timer (#wc6ryfte, then load ~21 on #5r8k77fe): every node the pass
    // touches goes through a Fragment's forEach / nodesBetween / descendants, so count those
    // callbacks. The count can't change with machine load.
    const small = page(100); // 500 lines
    const large = page(1000); // 5,000 lines
    const fragment = Object.getPrototypeOf(small.content) as Record<string, (...args: unknown[]) => unknown>;
    const visitsOf = (doc: ReturnType<typeof parse>) => {
      let visits = 0;
      const originals = new Map<string, (...args: unknown[]) => unknown>();
      for (const name of ["forEach", "nodesBetween", "descendants"]) {
        const original = fragment[name];
        if (typeof original !== "function") continue;
        originals.set(name, original);
        fragment[name] = function (this: unknown, ...args: unknown[]) {
          const callback = args.find((arg) => typeof arg === "function") as ((...inner: unknown[]) => unknown) | undefined;
          if (callback) {
            const counted = (...inner: unknown[]) => {
              visits += 1;
              return callback(...inner);
            };
            args = args.map((arg) => (arg === callback ? counted : arg));
          }
          return original.apply(this, args);
        };
      }
      try {
        expect(outlineOf(doc).length).toBeGreaterThan(0);
      } finally {
        for (const [name, original] of originals) fragment[name] = original;
      }
      return visits;
    };
    expect(outlineOf(large)).toHaveLength(1000);
    const smallVisits = visitsOf(small);
    const largeVisits = visitsOf(large);
    // Every top-level block once, plus each heading's own children: about 4 per section.
    expect(smallVisits).toBeGreaterThanOrEqual(100);
    expect(largeVisits).toBeLessThanOrEqual(10 * smallVisits + 10);
    expect(largeVisits).toBeLessThanOrEqual(6 * 1000);
    // `nestLevels` is one stack pass: each level is pushed once and popped at most once.
  });
});
