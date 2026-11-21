import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { baseEmbedMarkdown, baseEmbedMarkdownPlugin, parseBaseEmbed } from "../src/editor/base-embed/markdown-plugin";
import { parsePageEmbed } from "../src/editor/page-embed/markdown-plugin";

describe("database view embeds (D34)", () => {
  it("parses ![[X.base]] and ![[Folder/X.base#View]], keeping an alias as written", () => {
    expect(parseBaseEmbed("![[Tasks.base]]")).toEqual({ target: "Tasks.base", view: "", raw: "![[Tasks.base]]" });
    expect(parseBaseEmbed("![[Work/Tasks.base#Board]]")).toEqual({ target: "Work/Tasks.base", view: "Board", raw: "![[Work/Tasks.base#Board]]" });
    expect(parseBaseEmbed("![[Tasks.base#Board|my tasks]]")?.view).toBe("Board");
    expect(parseBaseEmbed("![[Tasks]]")).toBeNull();
    expect(parseBaseEmbed("![[Map.canvas]]")).toBeNull();
    // Not a page preview.
    expect(parsePageEmbed("![[Tasks.base#Board]]")).toBeNull();
  });

  it("writes an untouched embed back byte for byte, and a changed one in Obsidian's form", () => {
    const raw = "![[Tasks.base#Board|my tasks]]";
    expect(baseEmbedMarkdown({ target: "Tasks.base", view: "Board", raw })).toBe(raw);
    expect(baseEmbedMarkdown({ target: "Work items.base", view: "Board", raw })).toBe("![[Work items.base#Board]]");
    expect(baseEmbedMarkdown({ target: "Tasks.base", view: "", raw: "" })).toBe("![[Tasks.base]]");
  });

  it("is a block only on a line of its own", () => {
    const md = new MarkdownIt();
    baseEmbedMarkdownPlugin(md);
    expect(md.render("![[Tasks.base#Board]]\n")).toContain('<base-embed data-target="Tasks.base" data-view="Board"');
    expect(md.render("see ![[Tasks.base]] here\n")).not.toContain("<base-embed");
  });
});
