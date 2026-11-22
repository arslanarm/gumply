import { describe, expect, it } from "vitest";
import type { BaseRow, BaseView } from "@gumply/core";
import { imageOf } from "../src/bases/values.js";
import { display } from "../src/bases/TableView.js";
import { splitSnippet } from "../src/lib/backlinks.js";
import { obsidianLinkOf } from "../src/lib/file-links.js";
import { plainTextSnippet } from "../src/lib/search.js";
import { parseWikiLinkText } from "../src/lib/wikilinks.js";

/**
 * #wf4hhfj7: each web call site built from core's shared `[[…]]` syntax, pinned
 * to it. A link split across lines, or with a `[` inside, is plain text;
 * `![[x#^b|c]]` keeps its target, part and alias.
 */
const SPLIT = "[[A|b\nc]]";
const BRACKET = "[[a[b]]";

describe("every web call site follows the shared wikilink syntax", () => {
  it("lib/wikilinks parseWikiLinkText", () => {
    expect(parseWikiLinkText(SPLIT)).toBeNull();
    expect(parseWikiLinkText(BRACKET)).toBeNull();
    expect(parseWikiLinkText("[[x#^b|c]]")).toEqual({ title: "x", heading: "^b", alias: "c" });
  });

  it("lib/backlinks splitSnippet", () => {
    expect(splitSnippet(SPLIT)).toEqual([{ text: SPLIT, highlight: false }]);
    expect(splitSnippet(BRACKET)).toEqual([{ text: BRACKET, highlight: false }]);
    expect(splitSnippet("see ![[x#^b|c]]")).toEqual([
      { text: "see ", highlight: false },
      { text: "x#^b", highlight: true },
    ]);
  });

  it("lib/search plainTextSnippet", () => {
    expect(plainTextSnippet(BRACKET)).toBe(BRACKET);
    expect(plainTextSnippet("![[x#^b|c]]")).toBe("x#^b");
    expect(plainTextSnippet("[[x#^b|c]]")).toBe("c#^b");
  });

  it("bases/TableView display", () => {
    expect(display(SPLIT, "text")).toBe(SPLIT);
    expect(display(BRACKET, "text")).toBe(BRACKET);
    expect(display("[[x#^b|c]]", "text")).toBe("c");
  });

  it("lib/file-links obsidianLinkOf", () => {
    expect(obsidianLinkOf("![[pic\n.png]]")).toBeNull();
    expect(obsidianLinkOf("![[a[b.png]]")).toBeNull();
    expect(obsidianLinkOf("![[att/pic.png#p=2|100]]")).toBe("att/pic.png");
  });

  it("bases/values imageOf", () => {
    const view = { name: "Cards", type: "cards", image: "cover" } as unknown as BaseView;
    const row = (cover: string) =>
      ({ id: "P.md", values: { "note.cover": cover }, files: { "pic.png": "att/pic.png" } }) as unknown as BaseRow;
    expect(imageOf(row("![[pic.png|100]]"), view)?.url).toContain("att/pic.png");
    expect(imageOf(row("![[a[b.png]]"), view)).toBeNull();
  });
});
