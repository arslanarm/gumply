import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { editFrontmatterYaml, frontmatterKeys, orderedFrontmatterYaml } from "../src/note-template";
import { parseFrontmatter, serializeFrontmatter } from "../src/frontmatter";
import { isValidPropertyKey } from "../src/properties";

/**
 * #8s94nyhn: property names with punctuation, as spreadsheet headers have them, are written so YAML (and
 * so Obsidian) reads them back as themselves, and Gumply's own reader takes them back too. Invented keys.
 */

const PUNCTUATED = ["Water every (days)", "Price ($)", "E-mail/phone", "Due?", "a:b", "x: y", "#x", "-lead", 'say "hi"', "v1.2", "50%", "true", "12", "a #b", "[draft]", "{x}", "it's", "@home", "*star"];

describe("punctuated property keys round-trip", () => {
  it("every case is a valid key", () => {
    for (const key of PUNCTUATED) expect(isValidPropertyKey(key), key).toBe(true);
  });

  it("serializeFrontmatter writes them so both YAML and parseFrontmatter read each key back", () => {
    const frontmatter = Object.fromEntries(PUNCTUATED.map((key, index) => [key, `v${index}`]));
    const text = `${serializeFrontmatter(frontmatter)}\nBody\n`;
    const inner = text.split("\n---")[0]!.replace(/^---\n/, "");
    expect(parse(inner)).toEqual(frontmatter);
    expect(parseFrontmatter(text).frontmatter).toEqual(frontmatter);
  });

  it("the property editor's writer (editFrontmatterYaml) adds, edits and renames them, YAML-readable", () => {
    let yaml = "title: Fern\n";
    for (const [index, key] of PUNCTUATED.entries()) yaml = editFrontmatterYaml(yaml, { [key]: index });
    const expected = { title: "Fern", ...Object.fromEntries(PUNCTUATED.map((key, index) => [key, index])) };
    expect(parse(yaml)).toEqual(expected);
    expect(frontmatterKeys(yaml)).toEqual(["title", ...PUNCTUATED]);
    // A second edit finds the same line (no duplicate key).
    yaml = editFrontmatterYaml(yaml, { "Price ($)": 9 });
    expect(parse(yaml)["Price ($)"]).toBe(9);
    expect(frontmatterKeys(yaml).filter((key) => key === "Price ($)")).toHaveLength(1);
    // Renamed to a key that must be quoted, and back.
    yaml = editFrontmatterYaml(yaml, {}, [{ from: "Due?", to: "x: due" }]);
    expect(parse(yaml)["x: due"]).toBe(PUNCTUATED.indexOf("Due?"));
    yaml = editFrontmatterYaml(yaml, {}, [{ from: "x: due", to: "Due?" }]);
    expect(parse(yaml)["Due?"]).toBe(PUNCTUATED.indexOf("Due?"));
    expect(orderedFrontmatterYaml([["Water every (days)", 7]])).toBe("Water every (days): 7\n");
  });

  it("reads them as Obsidian writes them: plain, single- or double-quoted; an edit keeps the file's spelling", () => {
    const yaml = "Water every (days): 7\n'Price ($)': 3\n\"say \\\"hi\\\"\": yes # note\nE-mail/phone: a@b.c\nstatus: ok\n";
    const note = parseFrontmatter(`---\n${yaml}---\nBody`);
    expect(note.frontmatter).toEqual({ "Water every (days)": "7", "Price ($)": "3", 'say "hi"': "yes", "E-mail/phone": "a@b.c", status: "ok" });
    expect(editFrontmatterYaml(yaml, { "Price ($)": 4 })).toBe(yaml.replace("'Price ($)': 3", "'Price ($)': 4"));
    expect(editFrontmatterYaml(yaml, { 'say "hi"': "no" })).toBe(yaml.replace('yes # note', 'no # note'));
  });

  it("the keys valid before are written byte for byte as before", () => {
    expect(serializeFrontmatter({ status: "ok", "due date": "2026-01-02", статус: "x", "12": "n" })).toBe('---\n12: n\ndue date: 2026-01-02\nstatus: ok\nстатус: x\n---');
    expect(editFrontmatterYaml("a: 1\n", { "prio_1": 2 })).toBe("a: 1\nprio_1: 2\n");
  });

  it("a list item, a comment or a flow line is never read as a key", () => {
    const note = parseFrontmatter("---\ntags:\n  - one\n# Price ($): 3\n- (x): 2\n[a]: 1\n---\n");
    expect(note.frontmatter).toEqual({ tags: ["one"] });
  });
});
