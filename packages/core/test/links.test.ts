import { describe, expect, it } from "vitest";
import {
  collectLinkEdges,
  extractTags,
  extractWikilinks,
  makeSnippet,
  parseEmbeds,
  plainText,
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
    // A hex colour inside an HTML tag isn't a tag (#h368c8ni); the text it wraps can have one.
    expect(extractTags('<mark style="background: #FF5582A6;">pink #real</mark> <span style="color: #e03e3e">x</span> <font color="#f00">y</font>')).toEqual(["real"]);
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
      // A note embed is a page preview, so a link (#5dpxwac4).
      "Page",
      "v1.2",
      "notes.md",
      "Node.js",
      "ASP.NET",
      "example.com",
    ]);
  });

  it("does not treat Obsidian attachment embeds as wikilinks", () => {
    expect(extractWikilinks("![[audit-image.png]]")).toEqual([]);
    expect(extractWikilinks("[[report.pdf]]")).toEqual([]);
    expect(collectLinkEdges("q1-embed", "![[audit-image.png]]", [])).toEqual([]);
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

  // #u84ebtf3: several pages match equally well → Obsidian's pick, never list order.
  describe("same name in several places (Obsidian 1.14.4's rule)", () => {
    const board = (id: string, title: string): PageMeta => ({ ...page(id, title), kind: "whiteboard" });
    const cases: Array<{ name: string; link: string; pages: PageMeta[]; id: string }> = [
      { name: "root beats a folder", link: "Target", pages: [page("Target", "Target"), page("Other/Target", "Target")], id: "Target" },
      { name: "root beats a folder (listed second)", link: "Target", pages: [page("Other/Target", "Target"), page("Target", "Target")], id: "Target" },
      { name: "case-insensitive title too", link: "target", pages: [page("Other/Target", "Target"), page("Target", "Target")], id: "Target" },
      { name: "shortest path, not depth", link: "Target", pages: [page("Projects/Target", "Target"), page("a/b/Target", "Target")], id: "a/b/Target" },
      { name: "equal length: locale order, case-insensitive", link: "Target", pages: [page("b/Target", "Target"), page("A/Target", "Target")], id: "A/Target" },
      { name: "a path-qualified link is that file", link: "Other/Target", pages: [page("Target", "Target"), page("Other/Target", "Target")], id: "Other/Target" },
      { name: "a whole path wins over a page titled like it", link: "Other/Target", pages: [page("Weird", "Other/Target"), page("Other/Target", "Target")], id: "Other/Target" },
      { name: "a page before a whiteboard of that name", link: "Map", pages: [board("Map.canvas", "Map"), page("Deep/Folder/Map", "Map")], id: "Deep/Folder/Map" },
      { name: "file-name match: shortest path", link: "roadmap", pages: [page("notes/2026/roadmap", "Plan A"), page("notes/roadmap", "Plan B")], id: "notes/roadmap" },
    ];
    for (const item of cases) {
      it(item.name, () => {
        expect(resolveWikilink(item.link, item.pages)?.id).toBe(item.id);
        expect(resolveWikilink(item.link, [...item.pages].reverse())?.id).toBe(item.id);
      });
    }

    it("D4 still holds: a title match beats another page's file name", () => {
      expect(resolveWikilink("Target", [page("Target", "Something else"), page("Deep/Note", "Target")])?.id).toBe("Deep/Note");
    });
  });
});

describe("escaped openers (Obsidian: `\\[[x]]` is text)", () => {
  it("`\\[[x]]` is not a link; `\\\\[[x]]` is", () => {
    expect(extractWikilinks(String.raw`a \[[Gumply]] b`).map((link) => link.targetTitle)).toEqual([]);
    expect(extractWikilinks(String.raw`a \\[[Gumply]] b`).map((link) => link.raw)).toEqual(["[[Gumply]]"]);
    expect(extractWikilinks(String.raw`\\\[[Gumply]] [[Roadmap]]`).map((link) => link.targetTitle)).toEqual(["Roadmap"]);
  });

  it("an escaped link is never a graph edge or backlink", () => {
    expect(collectLinkEdges("roadmap-note", String.raw`See \[[Gumply#Intro]] and [[Roadmap]].`, pages)).toEqual([
      { source: "roadmap-note", target: "notes/roadmap", targetTitle: "Roadmap" },
    ]);
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

describe("a [[link]] never spans a line break, as in Obsidian (#pvrx7t6r)", () => {
  const split = "See [[Alpha|b\nc]] and ![[Beta\n]] and [[Gam\r\nma]].\n\nBut [[Alpha]] and ![[Beta#Part]] are links.";

  it("extractWikilinks and collectLinkEdges skip split links, wikilinks and embeds alike", () => {
    expect(extractWikilinks(split).map((link) => link.raw)).toEqual(["[[Alpha]]", "![[Beta#Part]]"]);
    expect(extractWikilinks("[[A\nB]]")).toEqual([]);
  });

  it("a rename never rewrites a split link", () => {
    const result = rewriteWikilinkTargets(split, (link) => link.targetTitle === "Alpha", "Omega");
    expect(result.count).toBe(1);
    expect(result.content).toBe(split.replace("But [[Alpha]]", "But [[Omega]]"));
  });

  it("embeds and plain text agree", () => {
    expect(parseEmbeds("![[pic.png\n]] ![[pic.png]]").map((embed) => embed.raw)).toEqual(["![[pic.png]]"]);
    expect(plainText("[[A|b\nc]]")).toContain("[[A|b");
  });
});
