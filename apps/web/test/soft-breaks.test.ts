import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";
import { escapeParagraphInterrupt } from "../src/editor/raw-markdown/text.js";

/** #iatezw4m: single newlines in a paragraph survive load and save. */

const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

const decode = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
/** `[before, after, lead?, quotePrefix?]` of each soft break in rendered HTML. */
const spaces = (markdown: string) =>
  [...md.render(markdown).matchAll(/data-md-break="soft"(?: data-md-space="([^"]*)")?/g)].map((m) =>
    m[1] === undefined ? null : JSON.parse(decode(m[1])),
  );

describe("soft breaks: parse", () => {
  it("a single newline is a soft line break; hard breaks keep their styles", () => {
    expect(md.render("Line one.\nLine two.")).toMatch(/^<p>Line one\.<br data-md-break="soft"[^>]*>Line two\.<\/p>/);
    expect(md.render("a  \nb\\\nc\nd")).toMatch(
      /^<p>a<br data-md-break="spaces">b<br data-md-break="backslash">c<br data-md-break="soft"[^>]*>d<\/p>/,
    );
  });

  it("records the whitespace around it: trailing space, indent in the block, the source line's own indent", () => {
    expect(spaces("Trailing \n    indented")).toEqual([[" ", "    ", "    "]]);
    // List continuations: the source line's indent verbatim (2, lazy 0, 4, tab).
    expect(spaces("- dash\n  two")).toEqual([["", "", "  "]]);
    expect(spaces("- lazy\ntwo")).toEqual([["", "", ""]]);
    expect(spaces("- four\n    two")).toEqual([["", "  ", "    "]]);
    expect(spaces("- [ ] task\n  two")).toEqual([["", "", "  "]]);
    expect(spaces("- a\n\t- tab\n\t  two")).toEqual([["", "", "\t  "]]);
    // Under a quote: no raw indent, but the line's own `>` prefix as written
    // (#ftx3awn7: `>>` stays `>>`, a lazy line of a nested quote keeps one `>`).
    expect(spaces("> quote one\n> quote two")).toEqual([["", "", "", "> "]]);
    expect(spaces(">> nested\n>> more\n> back")).toEqual([
      ["", "", "", ">> "],
      ["", "", "", "> "],
    ]);
  });

  it("a code span wrapped across lines stays raw (exact source); other breaks still soft", () => {
    const html = md.render("A `x\ny` b\nnext");
    expect(html).toContain('data-raw-md-inline="`x\ny`" data-raw-kind="code"');
    expect(spaces("A `x\ny` b\nnext")).toEqual([["", "", ""]]);
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
