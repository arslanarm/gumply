import type { PageMeta, SearchResult } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  recentPages,
  searchSections,
} from "../src/lib/search.js";

function page(
  id: string,
  title: string,
  updated = "2026-01-01T00:00:00.000Z",
  parentId: string | null = null,
): PageMeta {
  return {
    id,
    title,
    tags: [],
    parentId,
    childCount: 0,
    created: "2026-01-01T00:00:00.000Z",
    updated,
  };
}

function result(pageMeta: PageMeta, snippet = "", score = 1): SearchResult {
  return { page: pageMeta, snippet, score };
}

describe("recentPages", () => {
  it("returns the five most recently updated pages", () => {
    const pages = [
      page("a", "A", "2026-01-01T00:00:00.000Z"),
      page("b", "B", "2026-01-05T00:00:00.000Z"),
      page("c", "C", "2026-01-03T00:00:00.000Z"),
      page("d", "D", "2026-01-02T00:00:00.000Z"),
      page("e", "E"),
      page("f", "F", "2026-01-04T00:00:00.000Z"),
    ];
    expect(recentPages(pages).map((item) => item.id)).toEqual(["b", "f", "c", "d", "a"]);
  });

  it("breaks updated ties by title", () => {
    expect(
      recentPages([page("z", "Zed"), page("a", "Alpha")], 2).map((item) => item.id),
    ).toEqual(["a", "z"]);
  });
});

describe("searchSections", () => {
  const pages = [
    page("alpha", "Alpha"),
    page("beta", "Beta"),
    page("projects/plan", "Plan", "2026-01-01T00:00:00.000Z", "projects"),
    page("archive/plan", "Plan", "2026-01-01T00:00:00.000Z", "archive"),
  ];

  it("splits title matches from body-only matches", () => {
    const alpha = result(page("alpha", "Alpha"), "", 80);
    const beta = result(page("beta", "Beta"), "…a paragraph about alpha…", 2);

    const sections = searchSections([alpha, beta], pages, "alpha");
    expect(sections.pages.map((row) => row.label)).toEqual(["Alpha"]);
    expect(sections.text.map((row) => row.label)).toEqual(["Beta"]);
    expect(sections.text.map((row) => row.snippet)).toEqual(["…a paragraph about alpha…"]);
  });

  it("shows the folder path when titles collide", () => {
    const sections = searchSections(
      [result(pages[2]!), result(pages[3]!)],
      pages,
      "plan",
    );
    expect(sections.pages.map((row) => [row.label, row.path])).toEqual([
      ["Plan", "Projects"],
      ["Plan", "Archive"],
    ]);
  });

  it("adds Create “X” only when no exact title exists", () => {
    const create = searchSections([], pages, "  Road map  ").create;
    expect(create?.label).toBe("Create “Road map”");
    expect(create?.title).toBe("Road map");

    expect(searchSections([], pages, "alpha").create).toBeNull();
    expect(searchSections([], pages, "ALPHA").create).toBeNull();
  });

  it("returns nothing for an empty query", () => {
    expect(searchSections([result(pages[0]!)], pages, "   ")).toEqual({
      pages: [],
      text: [],
      create: null,
    });
  });

  it("caps each section at eight rows", () => {
    const many = Array.from({ length: 12 }, (_, index) => page(`p${index}`, `Page ${index}`));
    const results = many.map((item) => result(item));
    const sections = searchSections(results, many, "page");
    expect(sections.pages).toHaveLength(8);
  });
});

describe("highlightSegments", () => {
  it("returns plain text when there is no match", () => {
    expect(highlightSegments("No match here", "zzz")).toEqual([
      { text: "No match here", highlight: false },
    ]);
  });

  it("highlights every occurrence case-insensitively", () => {
    expect(highlightSegments("Plan the plan", "plan")).toEqual([
      { text: "Plan", highlight: true },
      { text: " the ", highlight: false },
      { text: "plan", highlight: true },
    ]);
  });

  it("treats regex characters literally", () => {
    expect(highlightSegments("a (b) c", "(b)")).toEqual([
      { text: "a ", highlight: false },
      { text: "(b)", highlight: true },
      { text: " c", highlight: false },
    ]);
  });
});
