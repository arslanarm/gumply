import { describe, expect, it } from "vitest";
import { rewriteLinksToPage } from "../src/link-target.js";
import {
  collectLinkEdges,
  extractWikilinks,
  formatBoardEmbed,
  isBoardTarget,
  resolveWikilink,
  rewriteWikilinkTargets,
} from "../src/links.js";
import { parseEmbeds } from "../src/embeds.js";
import type { PageMeta } from "../src/types.js";

const meta = (id: string, title: string): PageMeta =>
  ({ id, title, parentId: null, path: id.endsWith(".canvas") ? id : `${id}.md`, created: "", updated: "", tags: [] }) as unknown as PageMeta;

describe("board embeds (D30): syntax", () => {
  it("reads ![[Board.canvas]] and ![[Board.canvas|480]] as embed links", () => {
    const links = extractWikilinks("Intro\n\n![[Map.canvas]]\n\n![[Projects/Plan.canvas|480]]\n");
    expect(links).toEqual([
      { targetTitle: "Map.canvas", raw: "![[Map.canvas]]", index: 7, embed: true },
      {
        targetTitle: "Projects/Plan.canvas",
        raw: "![[Projects/Plan.canvas|480]]",
        index: 24,
        embed: true,
        size: "480",
      },
    ]);
  });

  it("keeps other ![[…]] embeds out of the links (attachments, notes)", () => {
    expect(extractWikilinks("![[pic.png]] ![[Some note]] ![[doc.pdf|2]]")).toEqual([]);
  });

  it("ignores embeds in code", () => {
    expect(extractWikilinks("`![[Map.canvas]]`\n\n```\n![[Map.canvas]]\n```\n")).toEqual([]);
  });

  it("a plain link to a board is still a link, not an embed", () => {
    const [link] = extractWikilinks("[[Map.canvas|Map]]");
    expect(link).toEqual({ targetTitle: "Map.canvas", alias: "Map", raw: "[[Map.canvas|Map]]", index: 0 });
  });

  it("is not an attachment embed", () => {
    expect(parseEmbeds("![[Map.canvas]]")).toEqual([]);
  });

  it("formats and recognises board targets", () => {
    expect(formatBoardEmbed("Map.canvas")).toBe("![[Map.canvas]]");
    expect(formatBoardEmbed("Map.canvas", 480)).toBe("![[Map.canvas|480]]");
    expect(formatBoardEmbed("Map.canvas", "")).toBe("![[Map.canvas]]");
    expect(isBoardTarget("Projects/Map.CANVAS")).toBe(true);
    expect(isBoardTarget("Map")).toBe(false);
  });
});

describe("board embeds (D30): backlinks and graph", () => {
  const pages = [meta("Notes", "Notes"), meta("Map.canvas", "Map")];

  it("an embed resolves to the board and makes an edge", () => {
    const [link] = extractWikilinks("![[Map.canvas|480]]");
    expect(resolveWikilink(link!.targetTitle, pages)?.id).toBe("Map.canvas");
    expect(collectLinkEdges("Notes", "![[Map.canvas|480]]", pages)).toEqual([
      { source: "Notes", target: "Map.canvas", targetTitle: "Map.canvas" },
    ]);
  });

  it("an embed of a missing board is an unresolved edge", () => {
    expect(collectLinkEdges("Notes", "![[Nope.canvas]]", pages)).toEqual([
      { source: "Notes", target: null, targetTitle: "Nope.canvas" },
    ]);
  });
});

describe("board embeds (D30): rename (D12)", () => {
  it("rewrites the target, keeps the ! and the height, adds no alias", () => {
    const before = [meta("Map.canvas", "Map")];
    const after = [meta("Roadmap.canvas", "Roadmap")];
    const body = "![[Map.canvas]]\n\n![[Map.canvas|480]]\n\nSee [[Map.canvas|Map]].";
    const out = rewriteLinksToPage(
      body,
      (link) => resolveWikilink(link.targetTitle, before)?.id === "Map.canvas",
      after[0]!,
      after,
      "Map",
    );
    expect(out.content).toBe("![[Roadmap.canvas]]\n\n![[Roadmap.canvas|480]]\n\nSee [[Roadmap.canvas|Roadmap]].");
    expect(out.count).toBe(3);
  });

  it("uses the full path when the file name is shared", () => {
    const before = [meta("Map.canvas", "Map")];
    const after = [meta("A/Plan.canvas", "Plan"), meta("B/Plan.canvas", "Plan")];
    const out = rewriteLinksToPage(
      "![[Map.canvas|300]]",
      (link) => resolveWikilink(link.targetTitle, before)?.id === "Map.canvas",
      after[0]!,
      after,
      "Map",
    );
    expect(out.content).toBe("![[A/Plan.canvas|300]]");
  });

  it("the title-only fallback writes a .canvas target", () => {
    const out = rewriteWikilinkTargets("x ![[Map.canvas|480]] y", () => true, "Roadmap");
    expect(out.content).toBe("x ![[Roadmap.canvas|480]] y");
  });
});
