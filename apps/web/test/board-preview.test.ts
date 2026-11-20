import { describe, expect, it } from "vitest";
import { previewText } from "../src/board/content/BoardCard.js";

describe("page card preview (#5kcn4jfc)", () => {
  it("drops a leading H1 that repeats the title", () => {
    expect(previewText("# Welcome\n\nGumply is **quiet**.", "Welcome")).toBe("Gumply is quiet.");
    expect(previewText("\n#  welcome  \nLine", "Welcome")).toBe("Line");
  });
  it("keeps a heading that says something else, or a later H1", () => {
    expect(previewText("# Welcome to Gumply\n\nHi", "Welcome")).toBe("Welcome to Gumply\nHi");
    expect(previewText("Intro\n\n# Welcome", "Welcome")).toBe("Intro\nWelcome");
    expect(previewText("## Welcome\nHi", "Welcome")).toBe("Welcome\nHi");
  });
});
