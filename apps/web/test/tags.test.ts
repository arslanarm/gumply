import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildTagTree, countTags, findTag } from "../src/lib/tags.js";
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

describe("tags pane tree (#9bx3aznb)", () => {
  it("nests #a/b, counts each page once per tag, and sorts by name", () => {
    const tree = buildTagTree(PAGES);
    expect(tree.map((node) => [node.tag, node.count])).toEqual([
      ["alpha", 1],
      ["home", 1],
      ["work", 3],
      ["zeta", 1],
    ]);
    const work = tree.find((node) => node.tag === "work")!;
    expect(work.children.map((node) => [node.tag, node.label, node.count])).toEqual([
      ["work/ideas", "ideas", 2],
      ["work/plans", "plans", 1],
    ]);
    expect(work.children[1]?.children.map((node) => node.tag)).toEqual(["work/plans/q3"]);
    expect(countTags(tree)).toBe(7);
    expect(findTag(tree, "WORK/ideas")?.count).toBe(2);
    expect(findTag(tree, "nope")).toBeNull();
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
