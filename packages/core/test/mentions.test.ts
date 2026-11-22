import { describe, expect, it } from "vitest";
import { findMentions, linkMentions, mentionLink, mentionSnippet, mentionTerms, mentionWords } from "../src/index";

/** v0.8 C1 (#sipu2nxn): unlinked mentions. */

const texts = (markdown: string, terms: string[]) => findMentions(markdown, terms).map((mention) => mention.text);

describe("findMentions", () => {
  it("word-bounded and case-insensitive", () => {
    expect(texts("Alpha, alpha. ALPHA! Alphabet alphas xAlpha alpha_1 alpha's", ["Alpha"])).toEqual(["Alpha", "alpha", "ALPHA", "alpha"]);
    expect(texts("Release 2 and release 20", ["Release 2"])).toEqual(["Release 2"]);
  });

  it("Cyrillic words and boundaries", () => {
    expect(texts("Про Проект, проект и Проекты; ПРОЕКТ.", ["Проект"])).toEqual(["Проект", "проект", "ПРОЕКТ"]);
    expect(texts("ёжик Ёжик ёжики", ["Ёжик"])).toEqual(["ёжик", "Ёжик"]);
  });

  it("aliases; the longest term wins where they overlap; spaces inside a term", () => {
    const found = findMentions("Project Alpha ships. Alpha too. PA is short.\nProject\tAlpha again", ["Alpha", "Project Alpha", "PA"]);
    expect(found.map((mention) => [mention.text, mention.term])).toEqual([
      ["Project Alpha", "Project Alpha"],
      ["Alpha", "Alpha"],
      ["PA", "PA"],
      ["Project\tAlpha", "Project Alpha"],
    ]);
  });

  it("never inside code, wikilinks, embeds, Markdown links, URLs or HTML", () => {
    const body = [
      "`Alpha` in code, [[Alpha]] and [[Other|Alpha]] and ![[Alpha#Goals]]",
      "[Alpha](https://example.com) ![Alpha](pic.png) <https://alpha.example/Alpha>",
      "https://example.com/Alpha?q=Alpha <span title=\"Alpha\">x</span>",
      "```",
      "Alpha in a fence",
      "```",
      "Only this Alpha counts.",
    ].join("\n");
    const found = findMentions(body, ["Alpha"]);
    expect(found).toHaveLength(1);
    expect(body.slice(found[0]!.index, found[0]!.index + found[0]!.length)).toBe("Alpha");
    expect(body.slice(0, found[0]!.index).endsWith("Only this ")).toBe(true);
  });

  it("a multi-word term doesn't match across a link or code", () => {
    expect(texts("Project [[x]] Alpha and Project `x` Alpha", ["Project Alpha"])).toEqual([]);
  });

  it("terms: title first, aliases after, no blanks, repeats or wordless terms", () => {
    expect(mentionTerms("Alpha", ["alpha", " Project  Alpha ", "", "—"])).toEqual(["Alpha", "Project Alpha"]);
    expect(mentionWords("Проект-Alpha 2_x")).toEqual(["проект", "alpha", "2_x"]);
  });
});

describe("linking", () => {
  it("[[Target]] when it reads the same, else [[Target|as written]]", () => {
    expect(mentionLink("Alpha", "Alpha")).toBe("[[Alpha]]");
    expect(mentionLink("Alpha", "alpha")).toBe("[[Alpha|alpha]]");
    expect(mentionLink("Alpha", "PA")).toBe("[[Alpha|PA]]");
    // Title differs from the file name: linkTargetFor's target, the text kept.
    expect(mentionLink("alpha-notes", "Alpha")).toBe("[[alpha-notes|Alpha]]");
  });

  it("replaces only the chosen mentions; every other byte stays (CRLF too)", () => {
    const body = "Alpha here.\r\nAnd alpha there, `Alpha` in code.\r\n";
    const mentions = findMentions(body, ["Alpha"]);
    expect(linkMentions(body, mentions, "Alpha")).toBe("[[Alpha]] here.\r\nAnd [[Alpha|alpha]] there, `Alpha` in code.\r\n");
    expect(linkMentions(body, [mentions[1]!], "Alpha")).toBe("Alpha here.\r\nAnd [[Alpha|alpha]] there, `Alpha` in code.\r\n");
  });

  it("snippets mark the mention", () => {
    const body = `${"x ".repeat(50)}see Alpha\nnow ${"y ".repeat(50)}`;
    const [mention] = findMentions(body, ["Alpha"]);
    const snippet = mentionSnippet(body, mention!, 10);
    expect(snippet.text.slice(snippet.start, snippet.end)).toBe("Alpha");
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text).not.toContain("\n");
  });
});
