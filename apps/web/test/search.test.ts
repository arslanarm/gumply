import type { PageMeta, SearchResult } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  recentPages,
  searchSections,
  wantsPageTemplate,
  wantsToday,
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
      createBoard: null,
      fromTemplate: null,
      language: null,
      today: null,
      pageTemplate: null,
    });
  });

  it("offers New board from template… for template words (#yewapn9k)", () => {
    for (const query of ["template", "templ", "new board", "Kanban", "mind map", "retro", "weekly"]) {
      expect(searchSections([], pages, query).fromTemplate?.label).toBe("New board from template…");
    }
    for (const query of ["alpha", "new", "board meeting notes", "kanbanx"]) {
      expect(searchSections([], pages, query).fromTemplate).toBeNull();
    }
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

describe("plainTextSnippet (#smwaixfp)", () => {
  it("reads like the page, not like Markdown", async () => {
    const { plainTextSnippet } = await import("../src/lib/search.js");
    expect(plainTextSnippet("…Back to [[Welcome]], or read [[Getting started|the guide]]…")).toBe(
      "…Back to Welcome, or read the guide…",
    );
    expect(plainTextSnippet("# Welcome to Gumply Type `[[` to link")).toBe("Welcome to Gumply Type [[ to link");
    expect(plainTextSnippet("- [ ] buy **milk** and _eggs_ ~~now~~ ==hl== see [docs](https://x.y)")).toBe(
      "buy milk and eggs now hl see docs",
    );
    expect(plainTextSnippet("> quoted <kbd>K</kbd> snake_case 2 * 3 a\\*b")).toBe("quoted K snake_case 2 * 3 a*b");
    expect(plainTextSnippet("[[Plan#Q3]] and ![[pic.png]]")).toBe("Plan#Q3 and pic.png");
  });
});

describe("duplicate titles in the same folder (#smwaixfp)", () => {
  it("are told apart by their edit time", async () => {
    const { recentRows, relativeTime } = await import("../src/lib/search.js");
    const now = Date.now();
    const meta = (id: string, minutesAgo: number) =>
      ({ id, title: "Race", parentId: null, path: `${id}.md`, updated: new Date(now - minutesAgo * 60_000).toISOString(), created: "" }) as unknown as PageMeta;
    const rows = recentRows([meta("a", 0), meta("b", 5)]);
    expect(rows.map((row) => row.path)).toEqual(["Edited just now", "Edited 5 min ago"]);
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 h ago");
  });

  it("offers Create whiteboard “X” next to Create “X” (spec/whiteboard §4)", () => {
    const pages = [{ id: "Roadmap", title: "Roadmap", tags: [], parentId: null, childCount: 0, created: "", updated: "" }] as PageMeta[];
    const sections = searchSections([], pages, " Roadmap 2027 ");
    expect(sections.create?.label).toBe("Create “Roadmap 2027”");
    expect(sections.createBoard).toMatchObject({ kind: "create-board", label: "Create whiteboard “Roadmap 2027”", title: "Roadmap 2027" });
    expect(searchSections([], pages, pages[0]!.title).createBoard).toBeNull();
  });

  it("offers Today and New page from template when asked (#5hrsrqsj)", () => {
    expect(wantsToday("tod")).toBe(true);
    expect(wantsToday("daily")).toBe(true);
    expect(wantsToday("to")).toBe(false);
    expect(wantsPageTemplate("template")).toBe(true);
    expect(wantsPageTemplate("new page from templ")).toBe(true);
    // "new page" alone is the create row, not a template.
    expect(wantsPageTemplate("new page")).toBe(false);
    expect(searchSections([], [], "today").today?.kind).toBe("today");
    expect(searchSections([], [], "template").pageTemplate?.kind).toBe("page-template");
  });
});

