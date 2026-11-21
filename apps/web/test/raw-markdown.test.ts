import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { detectListStyle } from "../src/editor/raw-markdown/list-style.js";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";
import { escapeMarkdownText } from "../src/editor/raw-markdown/text.js";

const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);
rawMarkdownPlugin(md); // idempotent: tiptap-markdown calls setup on every parse

const render = (source: string) => md.render(source).trim();
const decode = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** [kind, source] of every raw block in the rendered HTML. */
function rawBlocks(source: string): Array<[string, string]> {
  return [...render(source).matchAll(/<div data-raw-md="([^"]*)" data-raw-kind="([^"]*)"><\/div>/g)].map(
    (m) => [m[2]!, decode(m[1]!)],
  );
}

function rawInlines(source: string): Array<[string, string]> {
  return [...render(source).matchAll(/<span data-raw-md-inline="([^"]*)" data-raw-kind="([^"]*)"><\/span>/g)].map(
    (m) => [m[2]!, decode(m[1]!)],
  );
}

describe("raw Markdown blocks (#82x82ek7)", () => {
  it("leaves GFM tables to the editable table node, remembering their source (#7witbbun)", async () => {
    const { lastParsedTableSources } = await import("../src/editor/raw-markdown/markdown-plugin.js");
    const table = "| Name | Score |\n|------|-------|\n| Ann  | 10    |";
    expect(rawBlocks(`Intro\n\n${table}\n\nAfter`)).toEqual([]);
    expect(render(table)).toContain("<table>");
    expect(lastParsedTableSources()).toEqual([table]);
  });

  it("keeps footnote definitions and math blocks (callouts are editable nodes, #uigzc42i)", () => {
    expect(rawBlocks("> [!note] Callout title\n> Callout body text.")).toEqual([]);
    expect(rawBlocks("[^1]: The footnote.")).toEqual([["footnote", "[^1]: The footnote."]]);
    expect(rawBlocks("$$\n\\int_0^1 x\\,dx\n$$")).toEqual([["math", "$$\n\\int_0^1 x\\,dx\n$$"]]);
  });

  it("leaves an ordinary quote and paragraph alone", () => {
    expect(rawBlocks("> just a quote\n\ntext with [^ref] inline")).toEqual([]);
  });

  it("captures HTML without ever rendering it", () => {
    const html = '<details><summary>HTML</summary><img src=x onerror="alert(1)"></details>';
    const out = render(html);
    expect(out).not.toContain("<details>");
    expect(out).not.toContain("<img");
    expect(rawBlocks(html)).toEqual([["html", html]]);
    expect(render("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

describe("raw Markdown inline atoms", () => {
  it("keeps footnote refs, inline math and inline HTML (highlights are a mark now, #bg3cb83t)", () => {
    expect(rawInlines("a footnote[^1] and ==marked== and $e^{i\\pi}$ and <kbd>K</kbd>")).toEqual([
      ["footnote-ref", "[^1]"],
      ["math", "$e^{i\\pi}$"],
      ["html", "<kbd>"],
      ["html", "</kbd>"],
    ]);
  });

  it("keeps an escaped \\= as written, whatever highlight pairing surrounds it (#bg3cb83t)", () => {
    expect(rawInlines("c==d and \\==literal== here")).toEqual([["escape", "\\="]]);
    expect(rawInlines("\\==literal==")).toEqual([["escape", "\\="]]);
    // Other escapes are still plain text.
    expect(rawInlines("\\*not em\\*")).toEqual([]);
  });

  it("doesn't take prices or spaced operators for math or highlights", () => {
    expect(rawInlines("costs $5 and $10, a == b")).toEqual([]);
  });

  it("records the hard-break style", () => {
    expect(render("one  \ntwo\\\nthree")).toBe(
      '<p>one<br data-md-break="spaces">two<br data-md-break="backslash">three</p>',
    );
  });
});

describe("minimal text escaping", () => {
  const cases: Array<[string, string]> = [
    ["a > b, x < y, AT&T", "a > b, x < y, AT&T"],
    ["snake_case_name and array[0] and 2 * 3", "snake_case_name and array[0] and 2 * 3"],
    ["C:\\path\\file", "C:\\path\\file"],
    ["*bold?*", "\\*bold?\\*"],
    ["_em_", "\\_em\\_"],
    ["~~gone~~", "\\~~gone\\~~"],
    ["`code`", "\\`code\\`"],
    ["[text](url)", "\\[text\\](url)"],
    ["<b>tag</b>", "\\<b>tag\\</b>"],
    ["&amp; stays text", "\\&amp; stays text"],
    ["a\\*b", "a\\\\\\*b"],
  ];
  it.each(cases)("%s", (input, expected) => {
    expect(escapeMarkdownText(input, false)).toBe(expected);
  });

  it("escapes block syntax only at the start of a line", () => {
    expect(escapeMarkdownText("# not a heading", true)).toBe("\\# not a heading");
    expect(escapeMarkdownText("- not a list", true)).toBe("\\- not a list");
    expect(escapeMarkdownText("> not a quote", true)).toBe("\\> not a quote");
    expect(escapeMarkdownText("1. not a list", true)).toBe("1\\. not a list");
    expect(escapeMarkdownText("-5 degrees", true)).toBe("-5 degrees");
    expect(escapeMarkdownText("#tag", true)).toBe("#tag");
    expect(escapeMarkdownText("> mid", false)).toBe("> mid");
  });

  it("round-trips escaped text through markdown-it", () => {
    const plain = new MarkdownIt({ html: true });
    for (const [input] of cases) {
      const html = plain.renderInline(escapeMarkdownText(input, true));
      const text = decode(html);
      expect(text).toBe(input);
    }
  });
});

describe("list style detection", () => {
  it("finds the marker and nested indent", () => {
    expect(detectListStyle("- a\n    - b")).toEqual({ marker: "-", indent: "    " });
    expect(detectListStyle("* a\n\t* b")).toEqual({ marker: "*", indent: "\t" });
    expect(detectListStyle("text\n\n- a\n- b")).toEqual({ marker: "-", indent: "  " });
    expect(detectListStyle("---\n\n+ a\n  + b")).toEqual({ marker: "+", indent: "  " });
    expect(detectListStyle("```\n    - code\n```\n- a")).toEqual({ marker: "-", indent: "  " });
  });
});
