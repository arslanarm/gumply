import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";
import { escapeParagraphInterrupt } from "../src/editor/raw-markdown/text.js";

/** #iatezw4m: single newlines in a paragraph survive load and save. */

const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

describe("soft breaks: parse", () => {
  it("a single newline is a soft line break, with the whitespace around it recorded", () => {
    expect(md.render("Line one.\nLine two.")).toBe('<p>Line one.<br data-md-break="soft">Line two.</p>\n');
    expect(md.render("Trailing \n    indented")).toContain('data-md-space="[&quot; &quot;,&quot;    &quot;]"');
    // Hard breaks keep their own styles.
    expect(md.render("a  \nb\\\nc\nd")).toBe(
      '<p>a<br data-md-break="spaces">b<br data-md-break="backslash">c<br data-md-break="soft">d</p>\n',
    );
  });

  it("a code span over two lines: the break is still soft, its spaces just aren't recorded", () => {
    const html = md.render("Before `code\nspan` and\nafter");
    expect(html).toContain('<br data-md-break="soft">');
    expect(html).not.toContain("data-md-space");
  });
});

describe("soft breaks: what a line after one needs escaped (CommonMark paragraph interrupts)", () => {
  it("escapes only what would start a new block", () => {
    expect(escapeParagraphInterrupt("# Heading")).toBe("\\# Heading");
    expect(escapeParagraphInterrupt("> quote")).toBe("\\> quote");
    expect(escapeParagraphInterrupt("- item")).toBe("\\- item");
    expect(escapeParagraphInterrupt("* item")).toBe("\\* item");
    expect(escapeParagraphInterrupt("1. first")).toBe("1\\. first");
    expect(escapeParagraphInterrupt("1) first")).toBe("1\\) first");
    expect(escapeParagraphInterrupt("```js")).toBe("\\```js");
    expect(escapeParagraphInterrupt("---")).toBe("\\---");
    expect(escapeParagraphInterrupt("===")).toBe("\\===");
    // A lone dash under a paragraph line is a setext heading underline.
    expect(escapeParagraphInterrupt("-")).toBe("\\-");
    expect(escapeParagraphInterrupt("* * *")).toBe("\\* * *");
    expect(escapeParagraphInterrupt("  # indented heading")).toBe("  \\# indented heading");
  });

  it("leaves lines that can't interrupt a paragraph as written", () => {
    for (const line of ["2. item", "10. item", "#hashtag", "Plain text", "    # four spaces", "\t- tab", "a - b", "1.5 litres"]) {
      expect(escapeParagraphInterrupt(line)).toBe(line);
    }
  });

  it("every escaped line reads back as paragraph text after a soft break", () => {
    for (const line of ["# Heading", "> quote", "- item", "1. first", "```js", "---", "==="]) {
      const html = md.render(`First line\n${escapeParagraphInterrupt(line)}`);
      expect(html.startsWith("<p>First line<br")).toBe(true);
      expect(html.trim().endsWith("</p>")).toBe(true);
    }
  });
});
