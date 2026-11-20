import { describe, expect, it } from "vitest";
import { buildDemoPages, WELCOME_TITLE } from "../src/lib/demo.js";

const demo = buildDemoPages();

describe("buildDemoPages", () => {
  it("creates Welcome plus a demo folder with two pages", () => {
    expect(demo.map((page) => page.title)).toEqual([
      WELCOME_TITLE,
      "Gumply demo",
      "Getting started",
      "Graph view",
    ]);
  });

  it("lists parents before children", () => {
    expect(demo[0]?.parentId).toBeNull();
    expect(demo[1]?.parentId).toBeNull();
    expect(demo[2]?.parentId).toBe("gumply-demo");
    expect(demo[3]?.parentId).toBe("gumply-demo");
  });

  it("introduces the three core interactions and links the demo pages", () => {
    const welcome = demo[0]?.content ?? "";
    expect(welcome).toContain("Type `/` for commands");
    expect(welcome).toContain("Type `[[` to link a page");
    expect(welcome).toContain("Cmd/Ctrl+K");
    expect(welcome).toContain("[[Getting started]]");
    expect(welcome).toContain("[[Graph view]]");
    expect(welcome).toContain("Your notes are plain Markdown files");
  });

  it("has a unique title per demo page", () => {
    const titles = demo.map((page) => page.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });
});
