import { describe, expect, it } from "vitest";
import {
  collectLinkEdges,
  extractTags,
  extractWikilinks,
  makeSnippet,
  resolveWikilink,
  type PageMeta,
} from "../src/index";

function page(id: string, title: string): PageMeta {
  return {
    id,
    title,
    tags: [],
    parentId: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  };
}

const pages: PageMeta[] = [
  page("gumply", "Gumply"),
  page("projects/graph-view", "Graph View"),
  page("notes/roadmap", "Roadmap"),
];

describe("extractWikilinks", () => {
  it("parses plain, aliased and heading links", () => {
    const links = extractWikilinks("See [[Gumply]] and [[Graph View|the graph]] and [[Roadmap#Q1]].");
    expect(links.map((link) => link.targetTitle)).toEqual(["Gumply", "Graph View", "Roadmap"]);
    expect(links[1]?.alias).toBe("the graph");
    expect(links[2]?.heading).toBe("Q1");
    expect(links[0]?.raw).toBe("[[Gumply]]");
  });

  it("ignores links in fenced code and inline code", () => {
    const markdown = [
      "Real [[Real]]",
      "```md",
      "[[Fenced]]",
      "```",
      "Inline `[[Spoof]]` here",
    ].join("\n");
    expect(extractWikilinks(markdown).map((link) => link.targetTitle)).toEqual(["Real"]);
  });

  it("does not eat text after a code span containing an emoji", () => {
    const markdown = "A `😀 emoji` span and [[After]] with #tag";
    expect(extractWikilinks(markdown).map((link) => link.targetTitle)).toEqual(["After"]);
    expect(extractTags(markdown)).toEqual(["tag"]);
  });

  it("skips empty links", () => {
    expect(extractWikilinks("[[]] [[|alias]]")).toEqual([]);
  });

  it("collapses whitespace in targets", () => {
    expect(extractWikilinks("[[  Graph   View  ]]")[0]?.targetTitle).toBe("Graph View");
  });
});

describe("extractTags", () => {
  it("finds inline tags including nested ones", () => {
    expect(extractTags("#work and #nested/tag plus #work")).toEqual(["work", "nested/tag"]);
  });

  it("ignores headings, urls, wikilink headings and code", () => {
    const markdown = [
      "# Heading",
      "https://example.com/page#fragment",
      "[[Page#heading]]",
      "`#code`",
      "```",
      "#fenced",
      "```",
      "real #tag",
    ].join("\n");
    expect(extractTags(markdown)).toEqual(["tag"]);
  });
});

describe("resolveWikilink", () => {
  it("resolves by exact and case-insensitive title", () => {
    expect(resolveWikilink("Gumply", pages)?.id).toBe("gumply");
    expect(resolveWikilink("graph view", pages)?.id).toBe("projects/graph-view");
  });

  it("resolves by page id and file name", () => {
    expect(resolveWikilink("notes/roadmap", pages)?.id).toBe("notes/roadmap");
    expect(resolveWikilink("roadmap", pages)?.id).toBe("notes/roadmap");
  });

  it("returns null for unknown pages", () => {
    expect(resolveWikilink("Missing", pages)).toBeNull();
  });
});

describe("collectLinkEdges", () => {
  it("dedupes edges, drops self-links and marks unresolved links", () => {
    const edges = collectLinkEdges("gumply", "[[Gumply]] [[Graph View]] [[Graph View|g]] [[Missing]]", pages);
    expect(edges).toEqual([
      { source: "gumply", target: "projects/graph-view", targetTitle: "Graph View" },
      { source: "gumply", target: null, targetTitle: "Missing" },
    ]);
  });
});

describe("makeSnippet", () => {
  it("centres the excerpt on the match", () => {
    const content = `${"a ".repeat(60)}needle${" b".repeat(60)}`;
    const snippet = makeSnippet(content, "needle", 10);
    expect(snippet).toContain("needle");
    expect(snippet).toMatch(/^…/);
    expect(snippet).toMatch(/…$/);
  });

  it("truncates when the query is absent", () => {
    expect(makeSnippet("hello world", "zzz")).toBe("hello world");
    expect(makeSnippet("x".repeat(200), "zzz", 10).endsWith("…")).toBe(true);
  });

  it("returns an empty string for empty content", () => {
    expect(makeSnippet("   ", "x")).toBe("");
  });
});
