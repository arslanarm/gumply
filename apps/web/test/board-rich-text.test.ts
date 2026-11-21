import { describe, expect, it } from "vitest";
import { renderBoardMarkdown } from "../src/board/content/BoardRichText.js";

describe("board text: board embeds (#ux5cukze)", () => {
  it("reads ![[X.canvas]] as a link to the board, without a stray !", () => {
    expect(renderBoardMarkdown("self ![[Loop.canvas]]").trim()).toBe(
      '<p>self <wiki-link data-wikilink-title="Loop.canvas" data-wikilink-alias="Loop">Loop</wiki-link></p>',
    );
    expect(renderBoardMarkdown("![[Plans/Map.canvas|480]]").trim()).toBe(
      '<p><wiki-link data-wikilink-title="Plans/Map.canvas" data-wikilink-alias="Map">Map</wiki-link></p>',
    );
  });

  it("leaves other embeds and plain links as they were", () => {
    expect(renderBoardMarkdown("[[Loop.canvas|Loop]]")).toContain('data-wikilink-title="Loop.canvas"');
    expect(renderBoardMarkdown("![[pic.png]]")).toContain("<img");
  });
});
