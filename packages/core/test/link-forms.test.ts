import { describe, expect, it } from "vitest";
import { parseEmbeds } from "../src/embeds";
import { formatWikilink, rewriteLinksToPage } from "../src/link-target";
import { collectLinkEdges, extractWikilinks, resolveWikilink, rewriteWikilinkTargets } from "../src/links";
import type { PageMeta } from "../src/types";

/**
 * #siuwzhwy (@plony): a link that opens its page must also count as a link to it
 * (the graph, backlinks), and Copy link must write a link that resolves back. Each
 * case below failed on 0.9.3 (d00232b).
 */

function page(id: string, title?: string, kind: PageMeta["kind"] = "page"): PageMeta {
  return { id, title: title ?? id.split("/").pop()!, kind, tags: [], parentId: null, childCount: 0, created: "", updated: "" } as PageMeta;
}

/** The server's view of a link written in `Source`: its graph edge target. */
const edgeTarget = (markdown: string, pages: PageMeta[]) => collectLinkEdges("Source", markdown, pages)[0]?.target ?? null;

describe("a link with the file's extension means the page (#siuwzhwy)", () => {
  const pages = [page("Note"), page("Projects/Plan"), page("Source")];

  it("[[Note.md]] and [[Folder/Note.md]] resolve, as Obsidian resolves them", () => {
    expect(resolveWikilink("Note.md", pages, "Source")?.id).toBe("Note");
    expect(resolveWikilink("note.MD", pages, "Source")?.id).toBe("Note");
    expect(resolveWikilink("Projects/Plan.md", pages, "Source")?.id).toBe("Projects/Plan");
    expect(edgeTarget("See [[Note.md]] and [[Projects/Plan.md|the plan]].", pages)).toBe("Note");
    expect(collectLinkEdges("Source", "[[Projects/Plan.md|the plan]]", pages)[0]?.target).toBe("Projects/Plan");
  });

  it("a page really titled with .md still wins over the stripped name", () => {
    const withDotMd = [page("Note"), page("Note.md", "Note.md"), page("Source")];
    expect(resolveWikilink("Note.md", withDotMd, "Source")?.id).toBe("Note.md");
  });

  it("an unknown name stays unresolved, with or without .md", () => {
    expect(resolveWikilink("Nowhere.md", pages, "Source")).toBeNull();
    expect(resolveWikilink(".md", pages, "Source")).toBeNull();
  });
});

describe("decomposed (NFD) and composed (NFC) names are the same name (#siuwzhwy)", () => {
  const nfd = (value: string) => value.normalize("NFD");

  it("a page whose title or file name is NFD resolves from an NFC link, and the other way round", () => {
    const decomposedPage = [page(`Folder/${nfd("Café")}`, nfd("Café")), page("Source")];
    expect(resolveWikilink("Café", decomposedPage, "Source")?.id).toBe(`Folder/${nfd("Café")}`);
    const composedPage = [page("Folder/Café", "Café"), page("Source")];
    expect(resolveWikilink(nfd("Café"), composedPage, "Source")?.id).toBe("Folder/Café");
  });

  it("Cyrillic й and ё, decomposed, match their composed spelling", () => {
    const title = "Тайный ёж";
    const pages = [page(`Notes/${nfd(title)}`, nfd(title)), page("Source")];
    expect(nfd(title)).not.toBe(title); // the fixture really is decomposed
    expect(resolveWikilink(title, pages, "Source")?.id).toBe(`Notes/${nfd(title)}`);
    expect(edgeTarget(`[[${title}]]`, pages)).toBe(`Notes/${nfd(title)}`);
  });
});

describe("Copy link writes a link that resolves back to its page, whatever the title (#siuwzhwy)", () => {
  /** D20's file name for a title: these characters become spaces, collapsed. */
  const fileName = (title: string) => title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  const titles = ["Поход: Северный ветер", "[draft]", "Notes [v2]", "a [b] c", "A/B", "Why?", "C# notes", "x|y", "Plain title"];

  for (const title of titles) {
    it(`a sub-page titled ${JSON.stringify(title)}`, () => {
      const id = `Полка - список/${fileName(title)}`;
      const pages = [page("Полка - список"), page(id, title), page("Source")];
      const link = formatWikilink(pages[1]!, pages);
      const parsed = extractWikilinks(`See ${link}.`);
      expect(parsed, link).toHaveLength(1); // it is one link at all
      expect(resolveWikilink(parsed[0]!.targetTitle, pages, "Source")?.id).toBe(id);
      expect(edgeTarget(`See ${link}.`, pages)).toBe(id);
    });
  }

  it("the alias only loses the brackets: the rest of the title is shown as is", () => {
    const pages = [page("draft v2", "[draft] v2"), page("Source")];
    expect(formatWikilink(pages[0]!, pages)).toBe("[[draft v2]]");
    const more = [page("Notes 2", "Notes: [v2]"), page("Source")];
    expect(formatWikilink(more[0]!, more)).toBe("[[Notes 2|Notes: v2]]");
  });
});

describe("a link in a Markdown table cell, with its alias pipe written \\| (#siuwzhwy, @plony's root cause)", () => {
  const T = "Поход: Северный ветер";
  const file = "Полка - список/Книги/Повести/Поход Северный ветер";
  const pages = [page(file, T), page("Source")];
  const row = String.raw`| [[Поход Северный ветер\|Поход: Северный ветер]] | В планах |`;

  it("the target loses the escaping backslash, the alias is kept", () => {
    const [link] = extractWikilinks(row);
    expect(link?.targetTitle).toBe("Поход Северный ветер");
    expect(link?.alias).toBe(T);
    expect(link?.escapedPipe).toBe(true);
  });

  it("the server's edge (the graph) is the page, not a ghost", () => {
    expect(edgeTarget(`| Title | Status |\n|---|---|\n${row}\n`, pages)).toBe(file);
  });

  it("with a heading too", () => {
    const [link] = extractWikilinks(String.raw`| [[Note#Part\|shown]] |`);
    expect(link).toMatchObject({ targetTitle: "Note", heading: "Part", alias: "shown" });
    expect(edgeTarget(String.raw`| [[Note#Part\|shown]] |`, [page("Note"), page("Source")])).toBe("Note");
  });

  it("a link outside a table is unchanged: a plain | and a backslash in the alias stay as they are", () => {
    const [link] = extractWikilinks(String.raw`See [[Note|a \ b]].`);
    expect(link).toMatchObject({ targetTitle: "Note", alias: String.raw`a \ b` });
    expect(link?.escapedPipe).toBeUndefined();
  });

  it("a rename keeps the table's \\| (rewriteWikilinkTargets): the cell isn't split", () => {
    const text = String.raw`| [[Note\|shown]] | x |` + "\n";
    const out = rewriteWikilinkTargets(text, (link) => link.targetTitle === "Note", "Memo");
    expect(out.content).toBe(String.raw`| [[Memo\|shown]] | x |` + "\n");
  });

  it("a rename keeps \\| (rewriteLinksToPage), and a link that gains an alias in a table row gets \\|", () => {
    const renamed = page("Memo 2", "Memo: 2");
    const all = [renamed, page("Source")];
    const text = String.raw`| [[Note\|shown]] | [[Note]] |` + "\nOutside: [[Note]]\n";
    const out = rewriteLinksToPage(text, (link) => link.targetTitle === "Note", renamed, all, "Note");
    expect(out.content).toBe(String.raw`| [[Memo 2\|shown]] | [[Memo 2\|Memo: 2]] |` + "\nOutside: [[Memo 2|Memo: 2]]\n");
  });

  it("a board embed and an attachment link in a table cell name their file without the backslash", () => {
    const embeds = parseEmbeds(String.raw`| ![[report.pdf\|Report]] |`);
    expect(embeds[0]?.path).toBe("attachments/report.pdf");
    const [board] = extractWikilinks(String.raw`| ![[Map.canvas\|480]] |`);
    expect(board).toMatchObject({ targetTitle: "Map.canvas", size: "480", embed: true });
  });
});
