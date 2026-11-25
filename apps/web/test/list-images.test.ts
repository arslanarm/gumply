import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { rawMarkdownPlugin } from "../src/editor/raw-markdown/markdown-plugin.js";

/**
 * #mrh4dsr6 (D37): an image alone in a list item (`- ![A](a.png)`) reads as an
 * inline image inside the item, so it stays in the list and is written back
 * as it was; as a block it was lifted out and the list split on the next save.
 */
const md = new MarkdownIt({ html: false });
rawMarkdownPlugin(md);

/** Every <li>'s inner HTML, in order. */
const items = (source: string) => [...md.render(source).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
const inline = /^<img [^>]*data-inline-image="1"[^>]*>$/;

describe("an image alone in a list item stays in the item", () => {
  it("a bullet", () => {
    expect(items("- one\n- ![A](a.png)\n- two\n")[1]).toMatch(inline);
  });

  it("the list's only item", () => {
    expect(items("- ![A](a.png)\n")[0]).toMatch(inline);
  });

  it("an ordered list", () => {
    expect(items("1. one\n2. ![A](a.png)\n3. three\n")[1]).toMatch(inline);
  });

  it("a loose list (the item's paragraph is shown)", () => {
    expect(items("- one\n\n- ![A](a.png)\n\n- two\n")[1]).toMatch(/^<p><img [^>]*data-inline-image="1"[^>]*><\/p>$/);
  });

  it("an image alone on its own line outside a list is still a block", () => {
    const html = md.render("Top\n\n![A](a.png)\n");
    expect(html).toContain('<img src="a.png" alt="A"');
    expect(html).not.toContain("data-inline-image");
  });

  it("an image in a later paragraph of an item stays a block (the item can hold blocks after its text)", () => {
    const html = md.render("- one\n\n  ![A](a.png)\n");
    expect(html).not.toContain("data-inline-image");
  });
});
