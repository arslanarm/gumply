import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";
import { mathMarkdownPlugin } from "../src/lib/math-markdown.js";
import { mathToHtml } from "../src/lib/math.js";

/**
 * v0.8 F1 (#qx3w5qew): math. The editor keeps `$…$` / `$$…$$` as raw atoms
 * holding their exact source (so the file is written back byte for byte);
 * previews and stickies use the same detection; KaTeX never throws, never
 * trusts vault text.
 */

const editorMd = new MarkdownIt({ html: false });
rawMarkdownPlugin(editorMd);
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** [kind, exact source] of every raw atom the editor makes of `source`. */
function atoms(source: string): Array<[string, string]> {
  const html = editorMd.render(source);
  return [...html.matchAll(/data-raw-md(?:-inline)?="([^"]*)" data-raw-kind="([^"]*)"/g)].map((m) => [m[2]!, decode(m[1]!)]);
}

const previewMd = new MarkdownIt({ html: false });
mathMarkdownPlugin(previewMd);
const placeholders = (source: string) =>
  [...previewMd.render(source).matchAll(/data-math="([^"]*)"( data-math-display="true")?/g)].map((m) => [decode(m[1]!), m[2] ? "block" : "inline"]);

/** Every math fixture: the source, what the editor keeps, what previews typeset. */
const FIXTURES: Array<{ name: string; source: string; atoms: Array<[string, string]>; previews: string[][] }> = [
  { name: "block", source: "$$\n\\int_0^1 x\\,dx\n$$", atoms: [["math", "$$\n\\int_0^1 x\\,dx\n$$"]], previews: [["\\int_0^1 x\\,dx", "block"]] },
  { name: "one-line block", source: "$$E = mc^2$$", atoms: [["math", "$$E = mc^2$$"]], previews: [["E = mc^2", "block"]] },
  { name: "multi-line block", source: "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$", atoms: [["math", "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$"]], previews: [["\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}", "block"]] },
  { name: "inline", source: "Euler: $e^{i\\pi} + 1 = 0$ indeed", atoms: [["math", "$e^{i\\pi} + 1 = 0$"]], previews: [["e^{i\\pi} + 1 = 0", "inline"]] },
  { name: "single character", source: "let $x$ be", atoms: [["math", "$x$"]], previews: [["x", "inline"]] },
  { name: "two inline", source: "$a$ and $b^2$", atoms: [["math", "$a$"], ["math", "$b^2$"]], previews: [["a", "inline"], ["b^2", "inline"]] },
  { name: "prices", source: "costs $5 and $10 today", atoms: [], previews: [] },
  { name: "spaced dollars", source: "a $ x $ b", atoms: [], previews: [] },
  { name: "digit after", source: "$x$5 is not math", atoms: [], previews: [] },
  { name: "escaped dollar", source: "\\$x$ stays text", atoms: [], previews: [] },
  { name: "operators", source: "a == b and c != d", atoms: [], previews: [] },
  { name: "in code", source: "`$x$` and\n\n```\n$$y$$\n```", atoms: [], previews: [] },
];

describe("math atoms keep their exact source (the save path is unchanged)", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(atoms(fixture.source)).toEqual(fixture.atoms);
    });
  }
});

describe("previews and stickies use the same detection", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(placeholders(fixture.source)).toEqual(fixture.previews);
    });
  }

  it("placeholders escape the TeX (no HTML from vault text)", () => {
    const html = previewMd.render('$<img src=x onerror="alert(1)">$');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("mathToHtml", () => {
  it("typesets valid TeX", async () => {
    const html = await mathToHtml("\\frac{a}{b}");
    expect(html).toContain('class="katex"');
    expect(await mathToHtml("x^2", { display: true })).toContain("katex-display");
  });

  it("output: mathml gives MathML only (no KaTeX HTML, so no fonts or CSS needed)", async () => {
    const html = await mathToHtml("\\frac{a}{b}", { output: "mathml" });
    expect(html).toMatch(/^<span class="katex"><math[\s>]/);
    expect(html).toContain("<mfrac>");
    expect(html).not.toContain("katex-html");
    expect(await mathToHtml("x", { display: true, output: "mathml" })).toContain('display="block"');
    // The default keeps the typeset HTML.
    expect(await mathToHtml("x")).toContain("katex-html");
    // Errors are the same inline span either way.
    expect(await mathToHtml("\\frac{a}{", { output: "mathml" })).toContain("math-error");
  });

  it("never throws: bad TeX comes back as an inline error with the source", async () => {
    const html = await mathToHtml("\\frac{a}{");
    expect(html).toMatch(/^<span class="math-error" title="[^"]+">\\frac\{a\}\{<\/span>$/);
    expect(await mathToHtml("\\undefinedcommand")).toContain("math-error");
  });

  it("trusts nothing from the vault and stops runaway macros", async () => {
    const link = await mathToHtml("\\href{javascript:alert(1)}{x}");
    expect(link).not.toMatch(/href="javascript/i);
    const loop = await mathToHtml("\\def\\a{\\a}\\a");
    expect(loop).toContain("math-error");
    // maxSize caps every rendered dimension (the source still appears in the MathML annotation).
    const rule = await mathToHtml("\\rule{100000em}{1em}");
    const sizes = [...rule.matchAll(/(?:width|height)\s*:\s*([\d.]+)em/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
  });
});
