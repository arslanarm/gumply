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

  it("aliases; the longest term wins where they overlap", () => {
    const found = findMentions("Project Alpha ships. Alpha too. PA is short.", ["Alpha", "Project Alpha", "PA"]);
    expect(found.map((mention) => [mention.text, mention.term])).toEqual([
      ["Project Alpha", "Project Alpha"],
      ["Alpha", "Alpha"],
      ["PA", "PA"],
    ]);
  });

  it("multi-word titles: the exact sequence, case-insensitive; no extra spaces, never across a line break (Obsidian 1.14.4)", () => {
    const table: Array<[string, string, string[]]> = [
      ["Q1 plan", "The q1 plan is late. Q1 PLAN again.", ["q1 plan", "Q1 PLAN"]],
      ["Q1 plan", "Our Q1  plan (two spaces).", []],
      ["Q1 plan", "Split Q1\nplan across lines.", []],
      ["Q1 plan", "Split Q1\r\nplan across lines.", []],
      ["Q1 plan", "Tabbed Q1\tplan.", []],
      ["План на неделю", "Составили план на неделю вчера.", ["план на неделю"]],
      ["План на неделю", "Составили план  на неделю.", []],
      ["План на неделю", "Составили план на\nнеделю.", []],
    ];
    for (const [title, body, expected] of table) expect(texts(body, [title]), `${title} in ${JSON.stringify(body)}`).toEqual(expected);
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
    // Trimmed, but inner whitespace stays as written (it has to match exactly).
    expect(mentionTerms("Alpha", ["alpha", " Project  Alpha ", "", "—"])).toEqual(["Alpha", "Project  Alpha"]);
    expect(mentionWords("Проект-Alpha 2_x")).toEqual(["проект", "alpha", "2_x"]);
  });
});

describe("tags are never mentions (#sipu2nxn)", () => {
  it("a match that is (part of) a #tag is skipped, by Obsidian's tag rule", () => {
    const body = "Tag #Lighthouse, nested #Lighthouse/keeper, #lighthouse-, and Lighthouse itself. (#Lighthouse) a#Lighthouse #2024";
    expect(texts(body, ["Lighthouse"])).toEqual(["Lighthouse", "Lighthouse"]);
    // `a#Lighthouse` isn't a tag (no space before `#`), so it's a mention, as in Obsidian.
    expect(findMentions(body, ["Lighthouse"]).map((m) => body.slice(m.index - 2, m.index))).toEqual(["d ", "a#"]);
    // `#2024` isn't a tag (only digits): a page titled 2024 is mentioned there.
    expect(texts("Year #2024 and #2024/q1", ["2024"])).toEqual(["2024"]);
  });

  it("Link all leaves the tag as it was", () => {
    const body = "Tag #Lighthouse and Lighthouse.\n";
    const linked = linkMentions(body, findMentions(body, ["Lighthouse"]), (m) => mentionLink("Lighthouse", m.text, true));
    expect(linked).toBe("Tag #Lighthouse and [[Lighthouse]].\n");
  });
});

describe("linking", () => {
  it("as Obsidian 1.14.4: the text as written when it resolves, else [[target|text]]", () => {
    // Title match: the bare text resolves (case-insensitively).
    expect(mentionLink("Alpha", "alpha", true)).toBe("[[alpha]]");
    expect(mentionLink("Q1 plan", "q1 plan", true)).toBe("[[q1 plan]]");
    // Alias match: an alias isn't a link target.
    expect(mentionLink("Alpha Beta", "ab", false)).toBe("[[Alpha Beta|ab]]");
    expect(mentionLink("Alpha Beta", "AB", false)).toBe("[[Alpha Beta|AB]]");
    // Title isn't the file name: linkTargetFor's target, the text kept.
    expect(mentionLink("alpha-notes", "Alpha", false)).toBe("[[alpha-notes|Alpha]]");
  });

  it("replaces only the chosen mentions; every other byte stays (CRLF too)", () => {
    const body = "Alpha here.\r\nAnd alpha there, `Alpha` in code.\r\n";
    const mentions = findMentions(body, ["Alpha"]);
    const linkFor = (mention: { text: string }) => mentionLink("Alpha", mention.text, true);
    expect(linkMentions(body, mentions, linkFor)).toBe("[[Alpha]] here.\r\nAnd [[alpha]] there, `Alpha` in code.\r\n");
    expect(linkMentions(body, [mentions[1]!], linkFor)).toBe("Alpha here.\r\nAnd [[alpha]] there, `Alpha` in code.\r\n");
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

it("snippets cut at word edges, never mid-word", () => {
  const body = "Lighthouse budget approved. The beacon needs paint. Next week: lighthouse tour with the team.";
  const mentions = findMentions(body, ["Lighthouse"]);
  const last = mentionSnippet(body, mentions[1]!, 30);
  expect(last.text.startsWith("…")).toBe(true);
  expect(last.text).not.toMatch(/…\S*thouse budget/);
  expect(last.text.slice(1).split(" ")[0]).toMatch(/^[A-Za-z:.]+$/);
  const first = mentionSnippet(body, mentions[0]!, 30);
  expect(first.text.endsWith("…")).toBe(true);
  expect(body.includes(first.text.slice(0, -1))).toBe(true);
});
