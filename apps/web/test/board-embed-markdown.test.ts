import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import {
  boardEmbedMarkdown,
  boardEmbedMarkdownPlugin,
  embedHeight,
  parseBoardEmbed,
} from "../src/editor/board-embed/markdown-plugin.js";
import { wikilinkMarkdownPlugin } from "../src/editor/wikilink/markdown-plugin.js";

// Same order as the editor: the wiki link rules, then the embed rules.
const md = new MarkdownIt({ html: false });
wikilinkMarkdownPlugin(md);
boardEmbedMarkdownPlugin(md);

const render = (source: string) => md.render(source).trim();
const embed = (target: string, size: string, raw: string) =>
  `<board-embed data-target="${target}" data-size="${size}" data-raw="${raw}"></board-embed>`;

describe("board embeds in Markdown (D30)", () => {
  it("reads a line of its own as a block", () => {
    expect(render("![[Map.canvas]]")).toBe(embed("Map.canvas", "", "![[Map.canvas]]"));
    expect(render("![[Projects/Plan.canvas|480]]")).toBe(
      embed("Projects/Plan.canvas", "480", "![[Projects/Plan.canvas|480]]"),
    );
    expect(render("Intro\n\n![[Map.canvas]]\n\nOutro")).toBe(
      `<p>Intro</p>\n${embed("Map.canvas", "", "![[Map.canvas]]")}\n<p>Outro</p>`,
    );
  });

  it("an embed inside running text is still an embed (Obsidian renders it as a block)", () => {
    expect(render("See ![[Map.canvas]] here")).toBe(`<p>See ${embed("Map.canvas", "", "![[Map.canvas]]")} here</p>`);
  });

  it("works in lists and quotes", () => {
    expect(render("- ![[Map.canvas]]")).toContain(embed("Map.canvas", "", "![[Map.canvas]]"));
    expect(render("> ![[Map.canvas]]")).toContain(embed("Map.canvas", "", "![[Map.canvas]]"));
  });

  it("leaves code, links to boards and other embeds alone", () => {
    expect(render("    ![[Map.canvas]]")).toBe("<pre><code>![[Map.canvas]]\n</code></pre>");
    expect(render("`![[Map.canvas]]`")).toBe("<p><code>![[Map.canvas]]</code></p>");
    expect(render("[[Map.canvas|Map]]")).toBe(
      '<p><wiki-link data-wikilink-title="Map.canvas" data-wikilink-alias="Map">Map</wiki-link></p>',
    );
    expect(render("![[pic.png]]")).toBe('<p><img src="attachments/pic.png" alt="" data-obsidian="![[pic.png]]"></p>');
  });

  it("escapes what it writes into attributes", () => {
    expect(render('![[A "b" <c>.canvas]]')).toBe(
      embed("A &quot;b&quot; &lt;c&gt;.canvas", "", "![[A &quot;b&quot; &lt;c&gt;.canvas]]"),
    );
  });

  it("parses and writes back", () => {
    expect(parseBoardEmbed(" ![[Map.canvas|480]] ")).toEqual({ target: "Map.canvas", size: "480", raw: "![[Map.canvas|480]]" });
    expect(parseBoardEmbed("![[Map.canvas]] x")).toBeNull();
    expect(parseBoardEmbed("![[Map]]")).toBeNull();
    expect(embedHeight("480")).toBe(480);
    expect(embedHeight("")).toBeNull();
    expect(embedHeight("480x300")).toBeNull();
    // Untouched: byte for byte, even an unusual size.
    expect(boardEmbedMarkdown({ target: "Map.canvas", size: "480x300", raw: "![[Map.canvas|480x300]]" })).toBe(
      "![[Map.canvas|480x300]]",
    );
    // Resized or retargeted: the standard form.
    expect(boardEmbedMarkdown({ target: "Map.canvas", size: "520", raw: "![[Map.canvas|480x300]]" })).toBe(
      "![[Map.canvas|520]]",
    );
    expect(boardEmbedMarkdown({ target: "Route.canvas", size: "", raw: "![[Map.canvas]]" })).toBe("![[Route.canvas]]");
    expect(boardEmbedMarkdown({ target: "New.canvas", size: "", raw: "" })).toBe("![[New.canvas]]");
  });
});
