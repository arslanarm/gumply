import { describe, expect, it } from "vitest";
import {
  extractTags,
  findInlineTags,
  isValidTagName,
  renameInlineTag,
  renameTagList,
  tagMatches,
} from "../src/index.js";

describe("inline tags follow Obsidian's rules (#9bx3aznb)", () => {
  it("finds tags with their positions, repeats included", () => {
    expect(findInlineTags("#a then (#b/c) and #a")).toEqual([
      { tag: "a", index: 0 },
      { tag: "b/c", index: 9 },
      { tag: "a", index: 19 },
    ]);
  });

  it("skips all-digit tags but keeps mixed ones", () => {
    expect(extractTags("#2024 #y2024 #2024/notes #1_000")).toEqual(["y2024", "2024/notes", "1_000"]);
  });

  it("skips code, URLs, link targets, autolinks and wikilinks", () => {
    const markdown = [
      "`#code` and ```#also```",
      "```",
      "#fenced",
      "```",
      "[jump](#anchor) [x](https://e.com/#frag) <https://e.com/#auto>",
      "see https://e.com/path #real",
      "[[Page#Heading]] [[Page|alias #nope]]",
    ].join("\n");
    expect(extractTags(markdown)).toEqual(["real"]);
  });

  it("drops trailing / and -; headings aren't tags", () => {
    expect(extractTags("# Heading\n#tag/ and #x-")).toEqual(["tag", "x"]);
  });
});

describe("renaming a tag (#9bx3aznb)", () => {
  it("matches case-insensitively, with nested tags", () => {
    expect(tagMatches("Work", "work")).toBe(true);
    expect(tagMatches("work/ideas", "Work")).toBe(true);
    expect(tagMatches("workshop", "work")).toBe(false);
  });

  it("rewrites only the tags, byte for byte everywhere else", () => {
    const source = "Intro #work, #Work/ideas and #workshop.\r\n`#work` [x](#work) https://e.com/#work\r\n#work";
    const result = renameInlineTag(source, "work", "job");
    expect(result.count).toBe(3);
    expect(result.content).toBe("Intro #job, #job/ideas and #workshop.\r\n`#work` [x](#work) https://e.com/#work\r\n#job");
  });

  it("leaves a body without the tag untouched", () => {
    const source = "No tags here, just `#work`.";
    expect(renameInlineTag(source, "work", "job")).toEqual({ content: source, count: 0 });
  });

  it("renames in a frontmatter list, keeping order and merging duplicates", () => {
    expect(renameTagList(["alpha", "work/a", "job/a", "beta"], "work", "job")).toEqual(["alpha", "job/a", "beta"]);
    expect(renameTagList(["alpha"], "work", "job")).toBeNull();
  });

  it("accepts only names that read back as one tag", () => {
    for (const name of ["job", "Job/ideas", "q3-plan", "заметки", "2024/notes"]) expect(isValidTagName(name)).toBe(true);
    for (const name of ["", "two words", "#job", "2024", "a//b", "a/", "-a", "a#b"]) expect(isValidTagName(name)).toBe(false);
  });
});
