import { describe, expect, it } from "vitest";
import {
  embeddedMarkdown,
  extractWikilinks,
  newBlockId,
  pageBlock,
  pageBlockIds,
  pageHeadings,
  pageSection,
  parseEmbedPart,
  rewriteWikilinkTargets,
} from "../src/index";

const PAGE = [
  "Intro line.",
  "",
  "# Plan",
  "",
  "Plan text.",
  "",
  "## Goals",
  "",
  "- Ship it ^goal1",
  "  - with tests",
  "- Tell people",
  "",
  "```md",
  "# Not a heading",
  "fake ^nope",
  "```",
  "",
  "## Risks",
  "",
  "Time is short,",
  "and so is money. ^risk",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "^table",
  "",
  "# Later",
  "",
  "Later text.",
].join("\n");

describe("page previews: syntax (#5dpxwac4)", () => {
  it("reads ![[Page]], ![[Page#Heading]] and ![[Page#^id]] as embed links", () => {
    const links = extractWikilinks("![[Plan]]\n\n![[Plan#Goals]]\n\n![[Folder/Plan#^goal1|shown]]\n\nsee ![[pic.png]]");
    expect(links.map((link) => [link.targetTitle, link.heading ?? "", link.alias ?? "", link.embed])).toEqual([
      ["Plan", "", "", true],
      ["Plan", "Goals", "", true],
      ["Folder/Plan", "^goal1", "shown", true],
    ]);
  });

  it("tells the parts apart", () => {
    expect(parseEmbedPart(undefined)).toEqual({ kind: "page" });
    expect(parseEmbedPart("Goals")).toEqual({ kind: "heading", heading: "Goals" });
    expect(parseEmbedPart("Plan#Goals")).toEqual({ kind: "heading", heading: "Goals" });
    expect(parseEmbedPart("^goal1")).toEqual({ kind: "block", id: "goal1" });
  });

  it("a rename keeps the !, the #part and the alias", () => {
    const source = "![[Plan#Goals]] and ![[Plan#^goal1|g]] and [[Plan]]";
    const { content, count } = rewriteWikilinkTargets(source, (link) => link.targetTitle === "Plan", "Roadmap");
    expect(count).toBe(3);
    expect(content).toBe("![[Roadmap#Goals]] and ![[Roadmap#^goal1|g]] and [[Roadmap]]");
  });
});

describe("page previews: sections (#5dpxwac4)", () => {
  it("lists headings, skipping code", () => {
    expect(pageHeadings(PAGE).map((item) => `${item.level} ${item.text}`)).toEqual(["1 Plan", "2 Goals", "2 Risks", "1 Later"]);
  });

  it("a section runs to the next heading of the same or higher level", () => {
    const goals = pageSection(PAGE, "Goals")!;
    expect(goals.startsWith("## Goals")).toBe(true);
    expect(goals).toContain("# Not a heading"); // inside its code block
    expect(goals).not.toContain("## Risks");
    const plan = pageSection(PAGE, "plan")!; // case-insensitive
    expect(plan).toContain("## Risks");
    expect(plan).not.toContain("# Later");
    expect(pageSection(PAGE, "Later")).toBe("# Later\n\nLater text.");
  });

  it("matches headings by their words, not their Markdown; null when missing", () => {
    expect(pageSection("## The **big** [[Idea|plan]]\n\nx", "The big plan")).toBe("## The **big** [[Idea|plan]]\n\nx");
    expect(pageSection(PAGE, "Not a heading")).toBeNull();
    expect(pageSection(PAGE, "Missing")).toBeNull();
  });

  it("the first of two equal headings wins", () => {
    expect(pageSection("# A\n\none\n\n# A\n\ntwo", "A")).toBe("# A\n\none");
  });
});

describe("page previews: blocks (#5dpxwac4)", () => {
  it("lists block ids (not in code) with a short text", () => {
    expect(pageBlockIds(PAGE).map((block) => [block.id, block.text])).toEqual([
      ["goal1", "Ship it"],
      ["risk", "and so is money."],
      ["table", "1 2"],
    ]);
  });

  it("a list item comes with its nested lines, without the marker", () => {
    expect(pageBlock(PAGE, "goal1")).toBe("- Ship it\n  - with tests");
  });

  it("a paragraph is the lines between blank lines", () => {
    expect(pageBlock(PAGE, "risk")).toBe("Time is short,\nand so is money.");
  });

  it("an id on its own line names the block above it (a table)", () => {
    expect(pageBlock(PAGE, "table")).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
  });

  it("ids in code don't count; a missing id is null", () => {
    expect(pageBlock(PAGE, "nope")).toBeNull();
    expect(pageBlock(PAGE, "missing")).toBeNull();
  });

  it("embeddedMarkdown picks the part", () => {
    expect(embeddedMarkdown(PAGE, { kind: "page" })).toBe(PAGE);
    expect(embeddedMarkdown(PAGE, { kind: "block", id: "risk" })).toBe("Time is short,\nand so is money.");
    expect(embeddedMarkdown(PAGE, { kind: "heading", heading: "Nope" })).toBeNull();
  });

  it("new ids are 6 characters and never reuse one in the page", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    let call = 0;
    const id = newBlockId(PAGE, () => values[call++ % values.length]!);
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(pageBlockIds(PAGE).map((block) => block.id)).not.toContain(id);
  });
});
