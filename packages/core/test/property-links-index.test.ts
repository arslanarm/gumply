import { describe, expect, it } from "vitest";
import { collectLinkEdges, propertyLinks, type PageMeta } from "../src/index.js";

/**
 * #rpugpydh: which frontmatter values count as links, row for row from
 * @opus-hunter's Obsidian 1.14.4 measurements (`vault-c1obs/`,
 * `metadataCache.frontmatterLinks` and `resolvedLinks`).
 */

type Row = [name: string, yaml: string, pages: string[], files: string[]];

const ROWS: Row[] = [
  // Counted: the whole decoded value is exactly one non-embed link.
  ["QuotedDouble", 'related: "[[Alpha]]"', ["related:Alpha"], []],
  ["QuotedSingle", "sq: '[[Alpha]]'", ["sq:Alpha"], []],
  ["QuotedAlias", 'al: "[[Alpha|the a]]"', ["al:Alpha|the a"], []],
  ["QuotedBlockItem", 'refs:\n  - "[[Alpha]]"', ["refs:Alpha"], []],
  ["QuotedFlowItem", 'flow: ["[[Alpha]]", other]', ["flow:Alpha"], []],
  ["QuotedHeading", 'hd: "[[Alpha#Sec]]"', ["hd:Alpha"], []],
  // Not counted.
  ["Unquoted", "up: [[Alpha]]", [], []],
  ["UnquotedBlockItem", "refs:\n  - [[Alpha]]", [], []],
  ["PlainAround", "p: see [[Alpha]] here", [], []],
  ["QuotedAround", 'dq: "see [[Alpha]] here"', [], []],
  ["PlainItemAround", "items:\n  - see [[Alpha]] here", [], []],
  ["TwoLinks", 'two: "[[Alpha]] and [[Beta]]"', [], []],
  ["QuotedSpaces", 'sp: " [[Alpha]] "', [], []],
  ["QuotedEmbed", 'em: "![[Alpha]]"', [], []],
  ["QuotedEscaped", 'esc: "\\\\[[Alpha]]"', [], []],
  // File links: a link to an attachment-type file, never a page link.
  ["QuotedPdf", 'pdf: "[[a.pdf]]"', [], ["pdf:a.pdf"]],
  ["QuotedImgLink", 'img: "[[a.png]]"', [], ["img:a.png"]],
  ["QuotedImgEmbed", 'img: "![[a.png]]"', [], []],
  ["ListPdf", 'files:\n  - "[[a.pdf]]"', [], ["files:a.pdf"]],
];

function read(yaml: string) {
  const links = propertyLinks(yaml);
  return {
    pages: (links?.pages ?? []).map(({ key, link }) => `${key}:${link.targetTitle}${link.alias ? `|${link.alias}` : ""}`),
    files: (links?.files ?? []).map(({ key, name }) => `${key}:${name}`),
  };
}

describe("propertyLinks: frontmatter values that count as links (Obsidian 1.14.4)", () => {
  it.each(ROWS)("%s", (_name, yaml, pages, files) => {
    expect(read(yaml)).toEqual({ pages, files });
  });

  it("keeps the heading, and never reads tags, header keys or block scalars", () => {
    const links = propertyLinks('hd: "[[Alpha#Sec]]"\ntags: ["[[Alpha]]"]\ntitle: "[[Alpha]]"\nblock: |\n  [[Alpha]]\n');
    expect(links?.pages.map((entry) => entry.link)).toEqual([{ targetTitle: "Alpha", heading: "Sec", raw: "[[Alpha#Sec]]", index: 0 }]);
  });

  it("is null without links, for invalid YAML and for nothing", () => {
    expect(propertyLinks("status: done")).toBeNull();
    expect(propertyLinks('a: "[[Alpha]]"\n  bad: [')).toBeNull();
    expect(propertyLinks(null)).toBeNull();
    expect(propertyLinks("up: [[Alpha]]")).toBeNull();
  });

  it("reads a CRLF block with a comment", () => {
    expect(read('related: "[[Alpha]]" # main\r\nrefs:\r\n  - \'[[Beta]]\'\r\n')).toEqual({ pages: ["related:Alpha", "refs:Beta"], files: [] });
  });
});

const meta = (id: string): PageMeta => ({ id, title: id.split("/").pop()!, tags: [], parentId: null, created: "", updated: "", childCount: 0 });

describe("collectLinkEdges: one edge per target page (#rpugpydh)", () => {
  const pages = [meta("Alpha"), meta("Beta"), meta("Note")];

  it("two spellings of one page are one edge; ghosts stay one per title as written", () => {
    expect(collectLinkEdges("Note", "[[alpha]] [[Alpha]] [[Alpha#Sec]] [[Gone]] [[Gone]] [[gone]]", pages)).toEqual([
      { source: "Note", target: "Alpha", targetTitle: "alpha" },
      { source: "Note", target: null, targetTitle: "Gone" },
      { source: "Note", target: null, targetTitle: "gone" },
    ]);
  });

  it("adds frontmatter links after the body, marked via property only when the body doesn't link the page", () => {
    const fromProperties = propertyLinks('related: "[[Alpha]]"\nrefs:\n  - "[[Beta]]"\n  - "[[Missing]]"\nself: "[[Note]]"')!.pages.map((entry) => entry.link);
    expect(collectLinkEdges("Note", "See [[alpha]].", pages, fromProperties)).toEqual([
      { source: "Note", target: "Alpha", targetTitle: "alpha" },
      { source: "Note", target: "Beta", targetTitle: "Beta", via: "property" },
      { source: "Note", target: null, targetTitle: "Missing", via: "property" },
    ]);
  });

  it("resolves a frontmatter link from its own note, like the body (same-name pages in two folders)", () => {
    const vault = [meta("Projects/A"), meta("Projects/Sub/Three"), meta("Other/Three")];
    const fromProperties = propertyLinks('next: "[[Three]]"')!.pages.map((entry) => entry.link);
    expect(collectLinkEdges("Projects/A", "", vault, fromProperties).map((edge) => edge.target)).toEqual(["Projects/Sub/Three"]);
  });
});
