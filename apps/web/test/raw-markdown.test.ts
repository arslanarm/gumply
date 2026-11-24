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
    // Every escape is kept as written now (#628e927t).
    expect(rawInlines("\\*not em\\*")).toEqual([["escape", "\\*"], ["escape", "\\*"]]);
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

describe("backslash escapes and pairing-aware * / _ (#628e927t)", () => {
  it("keeps every backslash escape in the source as an atom", () => {
    expect(rawInlines("a\\,b \\$5 \\[x\\] \\\\ \\# \\_")).toEqual([
      ["escape", "\\,"],
      ["escape", "\\$"],
      ["escape", "\\["],
      ["escape", "\\]"],
      ["escape", "\\\\"],
      ["escape", "\\#"],
      ["escape", "\\_"],
    ]);
    // Not escapes: a backslash before a letter, a Windows path.
    expect(rawInlines("\\n and C:\\Users\\name")).toEqual([]);
  });

  it("escapes * and _ only where they could pair in the paragraph", () => {
    const write = (paragraph: string) => escapeMarkdownText(paragraph, false, { paragraph, offset: 0 });
    // Literal, so as written: an unmatched closer, intraword, a lone star.
    expect(write("\\sum_{i} and x_1_y")).toBe("\\sum_{i} and x_1_y");
    expect(write("5 * 3 and a*b")).toBe("5 * 3 and a*b");
    // Could pair: escaped, so a reload never turns them into emphasis.
    expect(write("2*3*4")).toBe("2\\*3\\*4");
    expect(write("_a_ and __b__")).toBe("\\_a\\_ and \\_\\_b\\_\\_");
    // A run pairs with a run in another text node of the same paragraph…
    expect(escapeMarkdownText("*x", false, { paragraph: "*x and y*", offset: 0 })).toBe("\\*x");
    expect(escapeMarkdownText(" y*", false, { paragraph: "*x and y*", offset: 6 })).toBe(" y\\*");
    // …but a closer before an opener never pairs (CommonMark), so no escape.
    expect(escapeMarkdownText("x*", false, { paragraph: "x* and *y", offset: 0 })).toBe("x*");
    // #6wnxxk4y: a backslash ending the block escapes nothing and stays single;
    // before more text, a mark or a line break it's still escaped.
    expect(escapeMarkdownText("C:\\dir\\", false, { paragraph: "C:\\dir\\", offset: 0, endsBlock: true })).toBe("C:\\dir\\");
    expect(escapeMarkdownText("C:\\dir\\", false, { paragraph: "C:\\dir\\ more", offset: 0, endsBlock: false })).toBe("C:\\dir\\\\");
    // Without a paragraph (pasted tables): the old, stricter rules.
    expect(escapeMarkdownText("a*b", false)).toBe("a\\*b");
  });
});

describe("tabs inside text (#ftx3awn7)", () => {
  it("keeps each tab as an atom; indentation is structure and untouched", () => {
    expect(rawInlines("Word\tafter and two\t\ttabs.")).toEqual([
      ["tab", "\t"],
      ["tab", "\t"],
      ["tab", "\t"],
    ]);
    expect(rawInlines("- item\twith tab")).toEqual([["tab", "\t"]]);
    expect(rawInlines("- parent\n\t- nested")).toEqual([]);
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

describe("list source attributes (#fmmght8w)", () => {
  it("records numbers as written, upper-case checks and blank lines before items", () => {
    const ordered = render(" 9. nine\n10. ten");
    expect(ordered).toContain('<li data-md-number=" 9">');
    expect(ordered).toContain('<li data-md-number="10">');
    expect(render("1. one\n\n10. ten")).toMatch(/<li data-md-gap="1" data-md-number="10">/);
    expect(render("- [X] done\n- [x] low")).toMatch(/data-md-check="X"[^>]*>[^]*<li(?![^>]*data-md-check)/);
    expect(render("> - a\n>\n> - b")).toContain('data-md-gap="1"');
    expect(render("- a\n- b")).not.toContain("data-md-gap");
  });

  it("marks a list that starts right under a line of text", () => {
    expect(render("- a\n\n- parent\n\t- nested")).toMatch(/<ul data-md-markup="-" data-md-after-text="true"[ >]/);
    expect(render("- a\n\n- parent\n\n  - nested")).not.toContain("data-md-after-text");
    expect(render("Text\n- a")).toContain('data-md-after-text="true"');
    expect(render("Text\n\n- a")).not.toContain("data-md-after-text");
  });

  it("writes recorded numbers only while they still rise from the start", async () => {
    const { recordedNumbers } = await import("../src/editor/raw-markdown/list-source.js");
    const list = (numbers: Array<string | null>) =>
      ({
        childCount: numbers.length,
        forEach: (f: (child: { attrs: { markdownNumber: string | null } }) => void) =>
          numbers.forEach((markdownNumber) => f({ attrs: { markdownNumber } })),
      }) as never;
    expect(recordedNumbers(list(["1", "10"]), 1)).toEqual(["1", "10"]);
    expect(recordedNumbers(list([" 9", "10"]), 9)).toEqual([" 9", "10"]);
    expect(recordedNumbers(list(["  1", "  2"]), 1)).toEqual(["1", "2"]);
    expect(recordedNumbers(list(["1", null]), 1)).toBeNull();
    expect(recordedNumbers(list(["2", "1"]), 2)).toBeNull();
    expect(recordedNumbers(list(["1", "2"]), 3)).toBeNull();
  });
});

describe("block joins (#54prcupx)", () => {
  it("stamps a block that starts right under its previous sibling, at any depth", () => {
    expect(render("## H\nText")).toContain('<p data-md-join="h&gt;p">');
    expect(render("## H\n\nText")).not.toContain("data-md-join");
    expect(render("Text\n## H")).toContain('data-md-join="p&gt;h"');
    expect(render("- a\n1. b")).toContain('data-md-join="ul:-&gt;ol:."');
    expect(render("***\n## H")).toContain('data-md-join="hr:*&gt;h"');
    expect(render("> ## H\n> Text")).toContain('data-md-join="h&gt;p"');
    // The first block in a container has no previous sibling.
    expect(render("> Text")).not.toContain("data-md-join");
  });

  it("an ordered list right before a bullet + task list is stamped, and the list split can't erase it (#q7ajxdr4)", async () => {
    // i2–i4 from @opus-hunter's rc.1 gate: the bullet list gets the join to the ordered list.
    expect(render("1. a\n- c\n- [ ] d")).toContain('<ul data-md-markup="-" data-md-join="ol:.&gt;ul:-">');
    expect(render("1. a\n2. b\n- c\n- [ ] d")).toContain('data-md-join="ol:.&gt;ul:-"');
    expect(render("1. a\n10. b\n- c\n- [ ] d\n\t- e")).toContain('data-md-join="ol:.&gt;ul:-"');
    // The split of a mixed list (markdown-task-list-fix) used the same attribute
    // name for its own loose-join mark, and removed this stamp with it.
    const { JOIN_ATTR } = await import("../src/editor/raw-markdown/block-joins.js");
    const { LOOSE_JOIN_ATTR } = await import("../src/editor/raw-markdown/list-source.js");
    expect(LOOSE_JOIN_ATTR).not.toBe(JOIN_ATTR);
  });

  it("writes the join only while both blocks are still the recorded kinds", async () => {
    const { joinsPrevious } = await import("../src/editor/raw-markdown/block-joins.js");
    const node = (name: string, attrs: Record<string, unknown> = {}, childCount = 1) =>
      ({ type: { name }, attrs, childCount }) as never;
    expect(joinsPrevious(node("heading"), node("paragraph", { markdownJoin: "h>p" }))).toBe(true);
    // The heading became text: the two paragraphs would merge.
    expect(joinsPrevious(node("paragraph"), node("paragraph", { markdownJoin: "h>p" }))).toBe(false);
    // A list marker changed, or a list that no longer starts at 1 under text.
    expect(joinsPrevious(node("bulletList", { markdownMarkup: "*" }), node("orderedList", { markdownJoin: "ul:->ol:.", markdownMarkup: "." }))).toBe(false);
    expect(joinsPrevious(node("paragraph"), node("orderedList", { markdownJoin: "p>ol:.", markdownMarkup: ".", start: 3 }))).toBe(false);
    expect(joinsPrevious(node("paragraph"), node("orderedList", { markdownJoin: "p>ol:.", markdownMarkup: ".", start: 1 }))).toBe(true);
    // An `hr` that would now be written `---` under text (a setext heading).
    expect(joinsPrevious(node("paragraph"), node("horizontalRule", { markdownJoin: "p>hr:*" }))).toBe(false);
    // An empty (typed) line never joins.
    expect(joinsPrevious(node("heading"), node("paragraph", { markdownJoin: "h>p" }, 0))).toBe(false);
  });
});

describe("escapes and entities in image alt text (#3zpgenmw, D37)", () => {
  /** The alt and the kept source of the first image. */
  const image = (source: string) => {
    const tag = /<img [^>]*>/.exec(render(source))![0];
    const attr = (name: string) => decode(new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? "");
    return { alt: attr("alt"), raw: attr("data-md-raw") };
  };

  it("an escaped character stays in the alt (markdown-it drops it inside an image)", () => {
    expect(image("![A\\|300](a.png)").alt).toBe("A|300");
    expect(image("![my\\_photo](a.png)").alt).toBe("my_photo");
    expect(image("![a\\*b\\*](a.png)").alt).toBe("a*b*");
    expect(image("![x \\[1\\]](a.png)").alt).toBe("x [1]");
    expect(image("x ![A\\|B](a.png) y").alt).toBe("A|B");
  });

  it("an entity stays in the alt, decoded", () => {
    expect(image("![a&amp;b](a.png)").alt).toBe("a&b");
    expect(image("![&copy; 2026](a.png)").alt).toBe("© 2026");
  });

  it("the source is kept as written, so an untouched image keeps its bytes", () => {
    expect(image("![A\\|300](a.png)").raw).toBe("![A\\|300](a.png)");
    expect(image("![my\\_photo](<my pic.png>)").raw).toBe("![my\\_photo](<my pic.png>)");
  });

  it("emphasis in the alt is still plain text (CommonMark), and text outside images is unchanged", () => {
    expect(image("![**bold** cat](a.png)").alt).toBe("bold cat");
    expect(render("a \\| b")).toContain("\\|");
  });
});

describe("the image alt fix in the other renderers (#3zpgenmw)", () => {
  it("imageAltMarkdownPlugin alone keeps escapes and entities in alts, and is idempotent", async () => {
    const { imageAltMarkdownPlugin } = await import("../src/editor/raw-markdown/markdown-plugin.js");
    const plain = new MarkdownIt({ html: false });
    imageAltMarkdownPlugin(plain);
    imageAltMarkdownPlugin(plain);
    expect(plain.render("![my\\_photo &amp; A\\|B](a.png)").trim()).toBe('<p><img src="a.png" alt="my_photo &amp; A|B"></p>');
    // With the full editor plugin on the same instance, the rule is there once.
    rawMarkdownPlugin(plain);
    expect(plain.core.ruler.__rules__.filter((rule: { name: string }) => rule.name === "gumply_image_alt")).toHaveLength(1);
  });
});
