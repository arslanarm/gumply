import { describe, expect, it } from "vitest";
import { previewLines } from "../src/board/content/BoardCard.js";

/** The preview's text, one line per entry (tasks as `[ ]` / `[x]` + text). */
const previewText = (markdown: string, title?: string) =>
  previewLines(markdown, title)
    .map((line) => (line.task ? `[${line.task.checked ? "x" : " "}] ${line.text}` : line.text))
    .join("\n");

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

describe("page card tasks (#vc4hivrr)", () => {
  it("keeps each task's state and text, in any list marker", () => {
    expect(previewLines("Plan\n- [ ] Draft **outline**\n- [x] Book room\n* [X] Send\n1. [ ] Numbered\n  - [ ] Nested")).toEqual([
      { text: "Plan" },
      { text: "Draft outline", task: { checked: false } },
      { text: "Book room", task: { checked: true } },
      { text: "Send", task: { checked: true } },
      { text: "Numbered", task: { checked: false } },
      { text: "Nested", task: { checked: false } },
    ]);
  });
  it("an empty task still counts; a plain bullet or `[link]` is not a task; fences are skipped", () => {
    expect(previewLines("- [ ]\n- not a task\n- [link](x)\n```\n- [ ] in code\n```")).toEqual([
      { text: "", task: { checked: false } },
      { text: "not a task" },
      { text: "link" },
    ]);
  });
});

describe("page card callouts and columns (#jchhjepb)", () => {
  it("a callout shows its title, or its type when it has none; its body follows", () => {
    expect(previewLines("> [!note] Remember\n> Callouts hold side notes.\n\n> [!TIP]-\n> Folded body\n>> [!warning] **Nested**")).toEqual([
      { text: "Remember" },
      { text: "Callouts hold side notes." },
      { text: "Tip" },
      { text: "Folded body" },
      { text: "Nested" },
    ]);
  });
  it("Pandoc column fences are structure, not text", () => {
    expect(previewLines(":::: {.columns}\n::: {.column width=\"40%\"}\nLeft.\n:::\n::: {.column}\nRight.\n:::\n::::")).toEqual([
      { text: "Left." },
      { text: "Right." },
    ]);
  });
  it("a quote that isn't a callout keeps its text", () => {
    expect(previewLines("> Just a quote")).toEqual([{ text: "Just a quote" }]);
  });
});
