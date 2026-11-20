import { describe, expect, it } from "vitest";
import { markdownLinks, plainText } from "../src/plain-text";

describe("plainText (#6zifz7da)", () => {
  it("drops inline formatting so phrases read as on screen", () => {
    expect(plainText("Plain **bold** text, *em*, _under_, ~~gone~~, ==hi==, `code`.")).toBe(
      "Plain bold text, em, under, gone, hi, code.",
    );
    expect(plainText("snake_case and 2 * 3 * 4 stay")).toBe("snake_case and 2 * 3 * 4 stay");
    expect(plainText("Escaped \\*stars\\* and \\[x\\]")).toBe("Escaped *stars* and [x]");
  });

  it("shows links as their visible text", () => {
    expect(plainText("See [[Getting started]] end.")).toBe("See Getting started end.");
    expect(plainText("Go to [[Ideas Q3|Ideas: Q3?]] now")).toBe("Go to Ideas: Q3? now");
    expect(plainText("Jump to [[Plan#Goals]]")).toBe("Jump to Plan#Goals");
    expect(plainText("Read [the docs](https://example.com/a_b) and ![a cat](cat.png)")).toBe("Read the docs and a cat");
    expect(plainText("Embed ![[attachments/diagram.png]] here")).toBe("Embed diagram.png here");
  });

  it("drops block markers but keeps the text, including code and tables", () => {
    const md = [
      "# Heading one",
      "> quoted **line**",
      "> [!note] Callout title",
      "- item one",
      "1. numbered",
      "- [x] done task",
      "---",
      "```ts",
      "const answer = 42;",
      "```",
      "| A | B |",
      "|---|:-:|",
      "| one | two |",
      "Soft",
      "break",
    ].join("\n");
    expect(plainText(md)).toBe(
      "Heading one quoted line Callout title item one numbered done task const answer = 42; A B one two Soft break",
    );
  });
});

describe("markdownLinks (#6zifz7da review)", () => {
  it("lists the targets plainText hides, with their visible text", () => {
    const md = [
      "Read [the docs](https://example.com/a_b \"Title\") and ![logo](<attachments/my logo.png>).",
      "Mail <mailto:me@example.com> or see <https://figma.com/file/1>.",
      "Ask [[Ideas Q3|the ideas page]], [[Plan#Goals|goals]] and [[Plain]].",
      "Bare https://github.com/foo stays in the plain text.",
      "`[not](a-link)` and",
      "```",
      "[also](not-a-link)",
      "```",
    ].join("\n");
    expect(markdownLinks(md)).toEqual([
      { target: "https://example.com/a_b", text: "the docs" },
      { target: "attachments/my logo.png", text: "logo" },
      { target: "Ideas Q3", text: "the ideas page" },
      { target: "Plan#Goals", text: "goals" },
    ]);
    // Bare URLs and autolinks are visible text already.
    expect(plainText(md)).toContain("https://github.com/foo");
    expect(plainText(md)).toContain("Mail mailto:me@example.com or see https://figma.com/file/1.");
  });
});
