import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";

/**
 * #sv5cwevx (D37): an image alone in a table cell reads as an inline image in the cell. As a block
 * it couldn't stay in the cell's paragraph, was lifted to the end of the page, and every save
 * appended another copy there.
 */
const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

const cells = (source: string) => [...md.render(source).matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]!.trim());

describe("an image alone in a table cell stays in the cell", () => {
  it("a body cell", () => {
    expect(cells("| A | B |\n|---|---|\n| text | ![A](a.png) |\n")[3]).toMatch(/^<img [^>]*data-inline-image="1"/);
  });

  it("a header cell", () => {
    expect(cells("| ![A](a.png) | B |\n|---|---|\n| x | y |\n")[0]).toMatch(/^<img [^>]*data-inline-image="1"/);
  });

  it("a table inside a quote (or callout) takes the same path", () => {
    const html = md.render("> | A | B |\n> |---|---|\n> | x | ![A](a.png) |\n");
    expect(html).toMatch(/<td[^>]*>\s*<img [^>]*data-inline-image="1"/);
  });

  it("an image with text in the cell was already inline (unchanged)", () => {
    expect(cells("| A |\n|---|\n| see ![A](a.png) |\n")[1]).toMatch(/data-inline-image="1"/);
  });

  it("an image alone on its own line outside a table is still a block", () => {
    expect(md.render("![A](a.png)\n")).not.toContain("data-inline-image");
  });
});
