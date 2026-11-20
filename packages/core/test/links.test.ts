import { describe, expect, it } from "vitest";
import {
  collectLinkEdges,
  extractTags,
  extractWikilinks,
  makeSnippet,
  resolveWikilink,
  rewriteWikilinkTargets,
  type PageMeta,
} from "../src/index";

function page(id: string, title: string): PageMeta {
  return {
    id,
    title,
    tags: [],
    parentId: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
    childCount: 0,
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

  it("does not let astral chars in code spans eat adjacent links or tags", () => {
    expect(extractWikilinks("`😀 [[H]]`[[Visible]]").map((link) => link.targetTitle)).toEqual([
      "Visible",
    ]);
    expect(extractWikilinks("`😀 [[H]]`[[One]][[Two]]").map((link) => link.targetTitle)).toEqual([
      "One",
      "Two",
    ]);
    expect(extractTags("`😀 x`#tag")).toEqual(["tag"]);
    // Guard: the same shape without astral chars already worked before the fix.
    expect(extractWikilinks("`abcd`[[Visible]]").map((link) => link.targetTitle)).toEqual([
      "Visible",
    ]);
  });

  it("skips empty links", () => {
    expect(extractWikilinks("[[]] [[|alias]]")).toEqual([]);
  });

  it("skips attachment embeds and attachment-extension targets", () => {
    const links = extractWikilinks(
      "[[Gumply]] ![[photo.png]] [[manual.pdf]] [[manual.pdf|the PDF]] ![[Page]] [[v1.2]] [[notes.md]] [[Node.js]] [[ASP.NET]] [[example.com]] [[report.PDF]]",
    );
    expect(links.map((link) => link.targetTitle)).toEqual([
      "Gumply",
      "v1.2",
      "notes.md",
      "Node.js",
      "ASP.NET",
      "example.com",
    ]);
  });

  it("does not create graph edges for attachments", () => {
    const edges = collectLinkEdges(
      "source",
      "See [[Gumply]], [[photo.png]] and ![[manual.pdf]].",
      pages,
    );
    expect(edges.map((edge) => edge.targetTitle)).toEqual(["Gumply"]);
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

describe("rewriteWikilinkTargets", () => {
  const rewriteAll = () => true;

  it("rewrites plain links, keeping aliases and headings", () => {
    const source = "A [[Old]] B [[Old|alias]] C [[Old#Q1]] D [[Old#Q1|read this]] E [[Other]]";
    const { content, count } = rewriteWikilinkTargets(
      source,
      (link) => link.targetTitle === "Old",
      "New Title",
    );
    expect(count).toBe(4);
    expect(content).toBe(
      "A [[New Title]] B [[New Title|alias]] C [[New Title#Q1]] D [[New Title#Q1|read this]] E [[Other]]",
    );
  });

  it("only rewrites links the predicate accepts", () => {
    const source = "Keep [[Old]] and change [[Target]]";
    const { content, count } = rewriteWikilinkTargets(
      source,
      (link) => link.targetTitle === "Target",
      "Renamed",
    );
    expect(count).toBe(1);
    expect(content).toBe("Keep [[Old]] and change [[Renamed]]");
  });

  it("leaves links in code spans and blocks alone", () => {
    const source = "`[[Old]]`\n\n```md\n[[Old]]\n```\n\nreal [[Old]]";
    const { content, count } = rewriteWikilinkTargets(source, rewriteAll, "New");
    expect(count).toBe(1);
    expect(content).toBe("`[[Old]]`\n\n```md\n[[Old]]\n```\n\nreal [[New]]");
  });

  it("returns the input unchanged when nothing matches", () => {
    const source = "No links here";
    expect(rewriteWikilinkTargets(source, rewriteAll, "New")).toEqual({
      content: source,
      count: 0,
    });
  });

  it("handles an emoji in an earlier code span without shifting", () => {
    const source = "`😀` then [[Old]]";
    expect(rewriteWikilinkTargets(source, rewriteAll, "New").content).toBe("`😀` then [[New]]");
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
