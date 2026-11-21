import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { boardEmbedMarkdownPlugin } from "../src/editor/board-embed/markdown-plugin.js";
import { pageEmbedMarkdown, pageEmbedMarkdownPlugin, parsePageEmbed } from "../src/editor/page-embed/markdown-plugin.js";
import { renderEmbeddedMarkdown, stripBlockIds } from "../src/editor/page-embed/render.js";
import { wikilinkMarkdownPlugin } from "../src/editor/wikilink/markdown-plugin.js";

// Same order as the editor: wiki links, board embeds, page previews.
const md = new MarkdownIt({ html: false });
wikilinkMarkdownPlugin(md);
boardEmbedMarkdownPlugin(md);
pageEmbedMarkdownPlugin(md);
const render = (source: string) => md.render(source).trim();
const block = (target: string, part: string, alias: string, raw: string) =>
  `<page-embed data-target="${target}" data-part="${part}" data-alias="${alias}" data-raw="${raw}"></page-embed>`;

describe("page previews in Markdown (#5dpxwac4)", () => {
  it("parses page, heading and block embeds; not boards or attachments", () => {
    expect(parsePageEmbed("![[Plan]]")).toEqual({ target: "Plan", part: "", alias: "", raw: "![[Plan]]" });
    expect(parsePageEmbed("![[Notes/Plan#Goals|g]]")).toEqual({ target: "Notes/Plan", part: "Goals", alias: "g", raw: "![[Notes/Plan#Goals|g]]" });
    expect(parsePageEmbed("![[Plan#^abc123]]")?.part).toBe("^abc123");
    expect(parsePageEmbed("![[Map.canvas]]")).toBeNull();
    expect(parsePageEmbed("![[photo.png]]")).toBeNull();
    expect(parsePageEmbed("see ![[Plan]]")).toBeNull();
  });

  it("a line of its own is the preview block; boards keep their own block", () => {
    expect(render("![[Plan#Goals]]")).toBe(block("Plan", "Goals", "", "![[Plan#Goals]]"));
    expect(render("![[Map.canvas]]")).toContain("<board-embed");
    expect(render("Intro\n\n![[Plan]]\n\nOutro")).toBe(`<p>Intro</p>\n${block("Plan", "", "", "![[Plan]]")}\n<p>Outro</p>`);
  });

  it("inside running text it stays text plus a link (byte for byte, as in B)", () => {
    expect(render("See ![[Plan]] here")).toBe('<p>See !<wiki-link data-wikilink-title="Plan">Plan</wiki-link> here</p>');
  });

  it("inside a callout the preview keeps the callout's > prefix (block rule in nested content)", () => {
    expect(render("> ![[Plan]]")).toBe(`<blockquote>\n${block("Plan", "", "", "![[Plan]]")}\n</blockquote>`);
  });

  it("writes back the original text until the embed changes", () => {
    expect(pageEmbedMarkdown({ target: "Plan", part: "Goals", alias: "", raw: "![[Plan#Goals]]" })).toBe("![[Plan#Goals]]");
    expect(pageEmbedMarkdown({ target: "Roadmap", part: "Goals", alias: "", raw: "![[Plan#Goals]]" })).toBe("![[Roadmap#Goals]]");
    expect(pageEmbedMarkdown({ target: "Plan", part: "^x1", alias: "", raw: "" })).toBe("![[Plan#^x1]]");
  });
});

describe("the read-only renderer (#5dpxwac4)", () => {
  it("never renders a page's raw HTML", () => {
    const html = renderEmbeddedMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1))');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
  });

  it("draws tasks, callouts, tags, marks and links like the editor", () => {
    const html = renderEmbeddedMarkdown("- [ ] open #work\n- [x] done\n\n> [!tip]- Hidden\n> body\n\n==hi== [[Plan|the plan]] `#code`");
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain('data-checked="false"');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('class="callout is-foldable is-closed" data-callout="tip"');
    expect(html).toContain('<div class="callout-title">Hidden</div>');
    expect(html).toContain('<span class="tag-chip" data-tag="work">#work</span>');
    expect(html).toContain("<mark>hi</mark>");
    expect(html).toContain('<wiki-link data-wikilink-title="Plan" data-wikilink-alias="the plan">the plan</wiki-link>');
    expect(html).toContain("<code>#code</code>");
  });

  it("nested previews become placeholders; boards become link cards", () => {
    const html = renderEmbeddedMarkdown("![[Other#Sec]]\n\n![[Map.canvas|480]]");
    expect(html).toContain('<div class="page-embed-nested" data-target="Other" data-part="Sec"></div>');
    expect(html).toContain('class="page-embed-board-card"');
    expect(html).not.toContain("<board-embed");
  });

  it("hides block ids, but not in code", () => {
    expect(stripBlockIds("Done ^abc123\n\n^table\n\n```\nx ^keep\n```")).toBe("Done\n\n\n\n```\nx ^keep\n```");
  });
});
