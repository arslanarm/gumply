import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildTagTree, findTag } from "../src/lib/tags.js";
import { searchSections, tagQuery } from "../src/lib/search.js";

function page(id: string, tags: string[], kind: PageMeta["kind"] = "page"): PageMeta {
  return { id, kind, title: id, tags, parentId: null, childCount: 0, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" };
}

const PAGES = [
  page("A", ["work", "work/ideas"]),
  page("B", ["Work/Ideas", "home"]),
  page("C", ["work/plans/q3"]),
  page("D", ["zeta", "alpha"]),
  page("Folder", ["work"], "folder"),
];

/** GET /api/tags for @opus-hunter's fixture A–E (see the server test), as the server returns it. */
const OBSIDIAN_TAGS = [
  { tag: "proj", count: 5, pages: ["A", "C", "D", "E"] },
  { tag: "proj/alpha", count: 3, pages: ["A", "B", "C"] },
  { tag: "y2024", count: 1, pages: ["D"] },
  { tag: "a-b_c", count: 1, pages: ["D"] },
  { tag: "proj/beta", count: 1, pages: ["B"] },
];

describe("tags pane tree (#9bx3aznb)", () => {
  it("matches Obsidian 1.14.4's pane: proj 9 › alpha 3, beta 1; then a-b_c 1, y2024 1", () => {
    const tree = buildTagTree(OBSIDIAN_TAGS);
    expect(tree.map((node) => [node.tag, node.count])).toEqual([
      ["proj", 9],
      ["a-b_c", 1],
      ["y2024", 1],
    ]);
    expect(tree[0]?.children.map((node) => [node.tag, node.label, node.count])).toEqual([
      ["proj/alpha", "alpha", 3],
      ["proj/beta", "beta", 1],
    ]);
    // The rename confirm counts pages: proj is in 5 of them.
    expect(tree[0]?.pages).toBe(5);
    expect(findTag(tree, "PROJ/Alpha")?.pages).toBe(3);
    expect(findTag(tree, "nope")).toBeNull();
  });

  it("sorts by name when asked, at every level", () => {
    const tree = buildTagTree([...OBSIDIAN_TAGS, { tag: "proj/Zed", count: 7, pages: ["Z"] }], "name");
    expect(tree.map((node) => node.tag)).toEqual(["a-b_c", "proj", "y2024"]);
    expect(tree[1]?.children.map((node) => node.label)).toEqual(["alpha", "beta", "Zed"]);
  });
});

describe("Cmd+K with #tag (#9bx3aznb)", () => {
  it("reads a tag query", () => {
    expect(tagQuery(" #work/ideas ")).toBe("work/ideas");
    expect(tagQuery("work")).toBeNull();
    expect(tagQuery("#two words")).toBeNull();
  });

  it("lists the tagged pages (nested too), then other text hits, and offers no Create", () => {
    const other = page("E", []);
    const sections = searchSections(
      [
        { page: PAGES[0]!, snippet: "#work", score: 1 },
        { page: other, snippet: "about #workshop", score: 1 },
      ],
      [...PAGES, other],
      "#work",
    );
    expect(sections.pages.map((row) => row.key)).toEqual(["A", "B", "C"]);
    expect(sections.text.map((row) => row.key)).toEqual(["E"]);
    expect(sections.create).toBeNull();
    expect(sections.createBoard).toBeNull();
  });
});
