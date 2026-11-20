import { describe, expect, it } from "vitest";
import { parseEmbeds } from "../src/embeds.js";

describe("parseEmbeds", () => {
  it("parses Markdown images and attachment file links", () => {
    const embeds = parseEmbeds("![A cat](attachments/cat.png) and [notes.pdf](attachments/notes.pdf)");
    expect(embeds).toHaveLength(2);
    expect(embeds[0]).toMatchObject({
      kind: "image",
      path: "attachments/cat.png",
      name: "cat.png",
      alt: "A cat",
      syntax: "markdown",
      index: 0,
    });
    expect(embeds[1]).toMatchObject({
      kind: "file",
      path: "attachments/notes.pdf",
      name: "notes.pdf",
      alt: "notes.pdf",
      syntax: "markdown",
    });
    expect(embeds[1]?.raw).toBe("[notes.pdf](attachments/notes.pdf)");
    expect(embeds[1]?.index).toBeGreaterThan(embeds[0]?.index ?? 0);
  });

  it("does not treat ordinary links as file embeds", () => {
    expect(parseEmbeds("[Gumply](https://example.com) [other](docs/other.md)")).toEqual([]);
  });

  it("parses Obsidian image embeds and file links with extensions", () => {
    const embeds = parseEmbeds("![[photo.PNG|300]] then [[manual.pdf]] and [[Page Title]]");
    expect(embeds.map((embed) => [embed.kind, embed.path, embed.syntax])).toEqual([
      ["image", "attachments/photo.PNG", "obsidian"],
      ["file", "attachments/manual.pdf", "obsidian"],
    ]);
    expect(embeds[0]?.name).toBe("photo.PNG");
    expect(embeds[0]?.raw).toBe("![[photo.PNG|300]]");
  });

  it("keeps a prefixed Obsidian path and classifies non-image embeds as files", () => {
    expect(parseEmbeds("![[attachments/report.pdf]]")[0]).toMatchObject({
      kind: "file",
      path: "attachments/report.pdf",
    });
  });

  it("ignores images and embeds inside code", () => {
    const markdown = [
      "`![inline](attachments/inline.png)`",
      "",
      "```md",
      "![fenced](attachments/fenced.png)",
      "![[fenced.png]]",
      "```",
      "",
      "![real](attachments/real.png)",
    ].join("\n");
    expect(parseEmbeds(markdown).map((embed) => embed.path)).toEqual(["attachments/real.png"]);
  });
});
