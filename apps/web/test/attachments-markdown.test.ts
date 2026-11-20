import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { wikilinkMarkdownPlugin } from "../src/editor/wikilink/markdown-plugin.js";

const md = new MarkdownIt({ html: false });
wikilinkMarkdownPlugin(md);

function render(source: string): string {
  return md.render(source).trim();
}

describe("attachment Markdown parsing (D19)", () => {
  it("keeps standard image Markdown as an image", () => {
    expect(render("![A diagram](attachments/pic.png)")).toBe(
      '<p><img src="attachments/pic.png" alt="A diagram"></p>',
    );
  });

  it("turns an attachments link into a file card", () => {
    expect(render("[brief.txt](attachments/brief.txt)")).toBe(
      '<p><file-attachment data-path="attachments/brief.txt" data-name="brief.txt">brief.txt</file-attachment></p>',
    );
  });

  it("accepts Obsidian embeds on read", () => {
    expect(render("![[pic.png]]")).toBe('<p><img src="attachments/pic.png" alt=""></p>');
    expect(render("[[brief.pdf]]")).toBe(
      '<p><file-attachment data-path="attachments/brief.pdf" data-name="brief.pdf">brief.pdf</file-attachment></p>',
    );
  });

  it("treats an unembedded image name as a file link", () => {
    expect(render("[[pic.png]]")).toBe(
      '<p><file-attachment data-path="attachments/pic.png" data-name="pic.png">pic.png</file-attachment></p>',
    );
  });

  it("leaves page links and ordinary links alone", () => {
    expect(render("[[Page]]")).toBe(
      '<p><wiki-link data-wikilink-title="Page">Page</wiki-link></p>',
    );
    expect(render("[[Node.js]]")).toBe(
      '<p><wiki-link data-wikilink-title="Node.js">Node.js</wiki-link></p>',
    );
    expect(render("[site](https://example.com)")).toBe(
      '<p><a href="https://example.com">site</a></p>',
    );
    expect(render("![remote](https://example.com/x.png)")).toBe(
      '<p><img src="https://example.com/x.png" alt="remote"></p>',
    );
  });

  it("keeps an alias/heading on page links", () => {
    expect(render("[[Plan|roadmap]]")).toBe(
      '<p><wiki-link data-wikilink-title="Plan" data-wikilink-alias="roadmap">roadmap</wiki-link></p>',
    );
    expect(render("[[Plan#Q3]]")).toBe(
      '<p><wiki-link data-wikilink-title="Plan" data-wikilink-heading="Q3">Plan</wiki-link></p>',
    );
  });
});
