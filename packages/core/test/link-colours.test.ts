import { describe, expect, it } from "vitest";
import { relinkFolderFiles } from "../src/attachment-paths";
import { rewriteLinksToPage } from "../src/link-target";
import { collectLinkEdges, rewriteWikilinkFolder, rewriteWikilinkTargets } from "../src/links";
import { markdownLinks } from "../src/plain-text";
import type { PageMeta } from "../src/types";

/**
 * #zvwk8irb (@plony: "every colour should work" on links): a coloured link is still a link to the
 * graph, backlinks and renames. Gumply writes a wiki link's colour as a span around it, and a
 * Markdown link's as a span inside its text; a rename or a folder move changes only the target and
 * keeps the span's bytes (D37). Invented names.
 */
function page(id: string, title?: string): PageMeta {
  return { id, title: title ?? id.split("/").pop()!, kind: "page", tags: [], parentId: null, childCount: 0, created: "", updated: "" } as PageMeta;
}

const RED = '<span style="color: var(--color-red);">';
const BLUE_BG = '<span style="background-color: rgba(var(--color-blue-rgb), 0.2);">';

describe("a coloured link is still a link (#zvwk8irb)", () => {
  const pages = [page("Target"), page("Source"), page("Projects/Plan")];

  it("a span around a wiki link: the graph edge and the backlink are the page", () => {
    const text = `See ${RED}[[Target]]</span> and ${BLUE_BG}${RED}[[Projects/Plan|the plan]]</span></span>.\n`;
    expect(collectLinkEdges("Source", text, pages).map((edge) => edge.target)).toEqual(["Target", "Projects/Plan"]);
  });

  it("a yellow highlight around a wiki link is an edge too", () => {
    expect(collectLinkEdges("Source", "==[[Target]]==\n", pages).map((edge) => edge.target)).toEqual(["Target"]);
  });

  it("a span inside a Markdown link's text: the link and its target are found", () => {
    const text = `[${RED}label</span>](Target.md) and [${BLUE_BG}other</span>](https://example.com)\n`;
    expect(markdownLinks(text).map((link) => [link.target, link.text])).toEqual([
      ["Target.md", "label"],
      ["https://example.com", "other"],
    ]);
  });

  it("a rename rewrites the coloured wiki link's target and keeps the span byte for byte", () => {
    const text = `A ${RED}[[Target]]</span> and ${BLUE_BG}[[Target|shown]]</span>.\n`;
    const out = rewriteWikilinkTargets(text, (link) => link.targetTitle === "Target", "Renamed");
    expect(out.content).toBe(`A ${RED}[[Renamed]]</span> and ${BLUE_BG}[[Renamed|shown]]</span>.\n`);
  });

  it("a rename that gives the link an alias (rewriteLinksToPage) keeps the span around it", () => {
    const renamed = page("Memo 2", "Memo: 2");
    const out = rewriteLinksToPage(`x ${RED}[[Target]]</span> y\n`, (link) => link.targetTitle === "Target", renamed, [renamed, page("Source")], "Target");
    expect(out.content).toBe(`x ${RED}[[Memo 2|Memo: 2]]</span> y\n`);
  });

  it("a folder move rewrites a coloured wiki link's folder and keeps the span", () => {
    const text = `${RED}[[Projects/Plan]]</span>\n`;
    expect(rewriteWikilinkFolder(text, "Projects", "Archive/Projects").content).toBe(`${RED}[[Archive/Projects/Plan]]</span>\n`);
  });

  it("a folder move rewrites a Markdown link with a span in its text and keeps the span", () => {
    const text = `[${RED}the doc</span>](Files/doc.pdf)\n`;
    const out = relinkFolderFiles(text, "Out", "Out", "Files", "Media");
    expect(out.content).toBe(`[${RED}the doc</span>](Media/doc.pdf)\n`);
    expect(out.count).toBe(1);
  });
});
