import { describe, expect, it } from "vitest";
import {
  editFrontmatterYaml,
  parseNoteTemplate,
  serializeNote,
  serializeNoteLike,
} from "../src/index";

const FILE = [
  "---",
  "# Obsidian-managed block",
  "title: My Note",
  "aliases:",
  "  - One",
  "  - Two",
  "cssclasses: [wide, cards]   # flow stays flow",
  "date: 2026-01-02",
  "tags: [x, y]",
  "updated: 2026-01-01T00:00:00.000Z",
  "---",
  "",
  "Body text.",
  "",
].join("\n");

describe("parseNoteTemplate", () => {
  it("keeps the inner YAML and line-ending/newline facts", () => {
    const template = parseNoteTemplate(FILE);
    expect(template.yaml).toContain("# Obsidian-managed block\n");
    expect(template.eol).toBe("\n");
    expect(template.finalNewline).toBe(true);
    expect(template.bom).toBe("");

    const crlf = parseNoteTemplate("\uFEFF---\r\ntitle: Win\r\n---\r\nBody");
    expect(crlf).toEqual({
      bom: "\uFEFF",
      yaml: "title: Win\n",
      eol: "\r\n",
      finalNewline: false,
    });
  });

  it("reports no frontmatter for plain notes or an unclosed block", () => {
    expect(parseNoteTemplate("Just text").yaml).toBeNull();
    expect(parseNoteTemplate("---\ntitle: broken").yaml).toBeNull();
  });
});

describe("serializeNoteLike", () => {
  it("changes only the updated line on a body-only edit", () => {
    const next = serializeNoteLike(
      parseNoteTemplate(FILE),
      {
        title: "My Note",
        tags: ["x", "y"],
        updated: "2026-11-20T12:00:00.000Z",
      },
      "Body text.",
      ["updated"],
    );

    const expected = FILE.replace(
      "updated: 2026-01-01T00:00:00.000Z",
      "updated: 2026-11-20T12:00:00.000Z",
    );
    expect(next).toBe(expected);
  });

  it("preserves unknown keys, order, comments and flow style on a title change", () => {
    const next = serializeNoteLike(
      parseNoteTemplate(FILE),
      {
        title: "Renamed",
        tags: ["x", "y"],
        updated: "2026-11-20T12:00:00.000Z",
      },
      "Body text.",
      ["title", "updated"],
    );

    expect(next).toContain("# Obsidian-managed block");
    expect(next).toContain("aliases:\n  - One\n  - Two");
    expect(next).toContain("cssclasses: [wide, cards]   # flow stays flow");
    expect(next).toContain("date: 2026-01-02");
    expect(next).toContain("tags: [x, y]");
    expect(next.indexOf("title:")).toBeLessThan(next.indexOf("aliases:"));
    expect(next.indexOf("aliases:")).toBeLessThan(next.indexOf("date:"));
    expect(next).toContain("title: Renamed");
  });

  it("keeps CRLF and the absence of a trailing newline", () => {
    const raw = "\uFEFF---\r\ntitle: Win\r\nupdated: old\r\n---\r\nBody";
    const next = serializeNoteLike(
      parseNoteTemplate(raw),
      { title: "Win", updated: "new" },
      "Body",
      ["updated"],
    );
    expect(next).toBe("\uFEFF---\r\ntitle: Win\r\nupdated: new\r\n---\r\n\r\nBody");
    expect(next.endsWith("\n")).toBe(false);
  });

  it("removes an icon and keeps the blank line before the next key", () => {
    const raw = "---\ntitle: T\nicon: 🚀\n\ncreated: 2026-01-01\n---\nBody\n";
    const next = serializeNoteLike(
      parseNoteTemplate(raw),
      { title: "T", created: "2026-01-01" },
      "Body",
      ["icon"],
    );
    expect(next).toBe("---\ntitle: T\n\ncreated: 2026-01-01\n---\n\nBody\n");
  });

  it("replaces tags in the existing style", () => {
    const flow = "---\ntitle: T\ntags: [a, b]\n---\nBody\n";
    expect(
      serializeNoteLike(
        parseNoteTemplate(flow),
        { title: "T", tags: ["a", "c"] },
        "Body",
        ["tags"],
      ),
    ).toContain("tags: [a, c]");

    const block = "---\ntitle: T\ntags:\n  - a\n  - b\n---\nBody\n";
    expect(
      serializeNoteLike(
        parseNoteTemplate(block),
        { title: "T", tags: ["a", "c"] },
        "Body",
        ["tags"],
      ),
    ).toContain("tags:\n  - a\n  - c");
  });

  it("adds a missing frontmatter block without touching the body", () => {
    const raw = "Body only";
    const next = serializeNoteLike(
      parseNoteTemplate(raw),
      { title: "New", created: "2026-01-01" },
      "Body only",
      ["title", "created"],
    );
    expect(next).toBe("---\ntitle: New\ncreated: 2026-01-01\n---\n\nBody only");
  });

  it("appends new keys after existing ones", () => {
    const raw = "---\ntitle: T\naliases: [a]\n---\n";
    const next = serializeNoteLike(
      parseNoteTemplate(raw),
      { title: "T", updated: "u" },
      "",
      ["updated"],
    );
    expect(next).toBe("---\ntitle: T\naliases: [a]\nupdated: u\n---\n");
  });

  it("stays compatible with the canonical serializer", () => {
    const frontmatter = { title: "My Page", tags: ["a", "b"], updated: "u" };
    expect(serializeNoteLike(null, frontmatter, "Body")).toBe(
      serializeNote(frontmatter, "Body"),
    );
  });
});

describe("editFrontmatterYaml", () => {
  it("does not re-render untouched keys", () => {
    const yaml = "# c\nfoo:   {a: 1}\nbar: 'x'\n";
    expect(editFrontmatterYaml(yaml, { updated: "u" })).toBe(
      "# c\nfoo:   {a: 1}\nbar: 'x'\nupdated: u\n",
    );
  });
});
