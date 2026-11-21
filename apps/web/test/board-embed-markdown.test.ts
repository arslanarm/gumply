import MarkdownIt from "markdown-it";
import { Schema } from "@tiptap/pm/model";
import { defaultMarkdownSerializer, MarkdownSerializer } from "prosemirror-markdown";
import { describe, expect, it } from "vitest";
import {
  boardEmbedMarkdown,
  boardEmbedMarkdownPlugin,
  embedHeight,
  parseBoardEmbed,
} from "../src/editor/board-embed/markdown-plugin.js";
import { wikilinkMarkdownPlugin } from "../src/editor/wikilink/markdown-plugin.js";
import { WikiLink } from "../src/editor/wikilink/node.js";

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

  it("inside running text it stays text plus a link, never a block (files stay yours)", () => {
    expect(render("See ![[Map.canvas]] here")).toBe(
      '<p>See !<wiki-link data-wikilink-title="Map.canvas">Map.canvas</wiki-link> here</p>',
    );
    // A line right under text belongs to that paragraph, as in CommonMark.
    expect(render("Intro\n![[Map.canvas|480]]")).toBe(
      '<p>Intro\n!<wiki-link data-wikilink-title="Map.canvas" data-wikilink-alias="480">480</wiki-link></p>',
    );
  });

  it("round-trips `see ![[X.canvas]] here` byte for byte after an unrelated edit", () => {
    // The document markdown-it + TipTap build for that file: text, a `!`, the
    // wiki link node, text; and a second paragraph the user edits.
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
        wikiLink: { group: "inline", inline: true, atom: true, attrs: { targetTitle: {}, alias: { default: "" }, heading: { default: "" } } },
      },
    });
    const wikiLinkSerializer = (WikiLink.config.addStorage as () => { markdown: { serialize: never } }).call({} as never)
      .markdown.serialize;
    const serializer = new MarkdownSerializer(
      {
        paragraph: defaultMarkdownSerializer.nodes.paragraph!,
        text: defaultMarkdownSerializer.nodes.text!,
        wikiLink: wikiLinkSerializer,
      },
      {},
    );
    const file = "see ![[X.canvas]] here\n\nOther text";
    const doc = (other: string) =>
      schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("see !"),
          schema.node("wikiLink", { targetTitle: "X.canvas" }),
          schema.text(" here"),
        ]),
        schema.node("paragraph", null, [schema.text(other)]),
      ]);
    expect(render(file)).toContain('<p>see !<wiki-link data-wikilink-title="X.canvas">X.canvas</wiki-link> here</p>');
    expect(serializer.serialize(doc("Other text"))).toBe(file);
    // An unrelated edit changes only that paragraph.
    expect(serializer.serialize(doc("Other text, edited"))).toBe("see ![[X.canvas]] here\n\nOther text, edited");
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
