import { describe, expect, it } from "vitest";
import {
  normalizeTags,
  parseFrontmatter,
  serializeFrontmatter,
  serializeNote,
  type Frontmatter,
} from "../src/index";

describe("parseFrontmatter", () => {
  it("parses scalars and block lists", () => {
    const raw = [
      "---",
      "title: My Page",
      "icon: 🚀",
      "tags:",
      "  - project",
      "  - '#nested/tag'",
      "created: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "Hello **world**",
    ].join("\n");

    const { frontmatter, content } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({
      title: "My Page",
      icon: "🚀",
      tags: ["project", "nested/tag"],
      created: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toBe("Hello **world**");
  });

  it("parses inline lists and quoted scalars", () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: "Plan: Q1"\ntags: [a, b, a]\n---\nbody');
    expect(frontmatter.title).toBe("Plan: Q1");
    expect(frontmatter.tags).toEqual(["a", "b"]);
  });

  it("keeps unknown keys", () => {
    const { frontmatter } = parseFrontmatter("---\ntitle: x\nauthor: someone\n---\n");
    expect(frontmatter.author).toBe("someone");
  });

  it("returns the file unchanged when there is no complete block", () => {
    expect(parseFrontmatter("Just a note")).toEqual({ frontmatter: {}, content: "Just a note" });
    expect(parseFrontmatter("---\ntitle: broken\nbody")).toEqual({
      frontmatter: {},
      content: "---\ntitle: broken\nbody",
    });
  });

  it("handles BOM and CRLF line endings", () => {
    const { frontmatter, content } = parseFrontmatter("\uFEFF---\r\ntitle: Win\r\n---\r\n\r\nHi");
    expect(frontmatter.title).toBe("Win");
    expect(content).toBe("Hi");
  });

  it("does not treat --- inside the body as a fence", () => {
    const { content } = parseFrontmatter("---\ntitle: x\n---\nintro\n\n---\n\nmore");
    expect(content).toBe("intro\n\n---\n\nmore");
  });
});

describe("normalizeTags", () => {
  it("strips hashes, splits strings and dedupes case-insensitively", () => {
    expect(normalizeTags("#Work, work,  personal ")).toEqual(["Work", "personal"]);
    expect(normalizeTags(["#a", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeTags(42)).toEqual([]);
  });
});

describe("serializeFrontmatter", () => {
  it("writes tags as a block list in a stable key order", () => {
    const text = serializeFrontmatter({ created: "now", tags: ["b", "a"], title: "T" });
    expect(text).toBe(["---", "title: T", "tags:", "  - b", "  - a", "created: now", "---"].join("\n"));
  });

  it("quotes values that need it", () => {
    const text = serializeFrontmatter({ title: "Plan: Q1" });
    expect(text).toContain('title: "Plan: Q1"');
  });

  it("writes an explicit empty list for no tags", () => {
    expect(serializeFrontmatter({ tags: [] })).toContain("tags: []");
  });
});

describe("serializeNote", () => {
  const frontmatter: Frontmatter = {
    title: "My Page",
    icon: "🚀",
    tags: ["project", "nested/tag"],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
  };
  const content = "# Heading\n\nA [[Link]] and #tag.\n\n- item";

  it("round-trips frontmatter and body", () => {
    const file = serializeNote(frontmatter, content);
    expect(parseFrontmatter(file)).toEqual({ frontmatter, content });
  });

  it("writes a bare body when there is no frontmatter", () => {
    expect(serializeNote({}, "Hello")).toBe("Hello\n");
    expect(serializeNote({}, "")).toBe("");
  });

  it("normalises CRLF and trailing whitespace", () => {
    const file = serializeNote({ title: "T" }, "a\r\nb   \n\n");
    expect(file.endsWith("a\nb\n")).toBe(true);
  });
});
