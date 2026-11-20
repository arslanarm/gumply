import { describe, expect, it } from "vitest";
import { plainText } from "../src/plain-text";

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
