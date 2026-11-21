import { describe, expect, it } from "vitest";
import { editFrontmatterYaml } from "../src/note-template";
import { coercePropertyValue, inferPropertyType, isValidPropertyKey } from "../src/properties";

describe("property types (v0.7 A, D34)", () => {
  it("infers from the values, tags/aliases by name, text when unsure", () => {
    expect(inferPropertyType("tags", ["x"])).toBe("tags");
    expect(inferPropertyType("aliases", [])).toBe("aliases");
    expect(inferPropertyType("done", [true, false])).toBe("checkbox");
    expect(inferPropertyType("rank", [1, 2.5])).toBe("number");
    expect(inferPropertyType("due", ["2026-11-21", null])).toBe("date");
    expect(inferPropertyType("at", ["2026-11-21T09:30"])).toBe("datetime");
    expect(inferPropertyType("people", [["a", "b"]])).toBe("multitext");
    expect(inferPropertyType("status", ["todo", "done", 3])).toBe("text");
    expect(inferPropertyType("empty", [null, ""])).toBe("text");
  });

  it("coerces a value into its type's shape, or refuses", () => {
    expect(coercePropertyValue("number", "3.5")).toBe(3.5);
    expect(coercePropertyValue("number", "three")).toBeUndefined();
    expect(coercePropertyValue("checkbox", "true")).toBe(true);
    expect(coercePropertyValue("checkbox", "yes")).toBeUndefined();
    expect(coercePropertyValue("tags", ["#a", " b ", ""])).toEqual(["a", "b"]);
    expect(coercePropertyValue("multitext", "one")).toEqual(["one"]);
    expect(coercePropertyValue("date", "2026-11-21T10:00")).toBe("2026-11-21");
    expect(coercePropertyValue("datetime", "2026-11-21")).toBe("2026-11-21T00:00");
    expect(coercePropertyValue("date", "next week")).toBeUndefined();
    expect(coercePropertyValue("text", "")).toBeNull();
  });

  it("accepts Obsidian-style keys in any script, refuses YAML-breaking ones", () => {
    for (const key of ["status", "due date", "статус", "prio_1", "a-b"]) expect(isValidPropertyKey(key), key).toBe(true);
    for (const key of ["", " pad", "a:b", "#x", "-lead", "x".repeat(101)]) expect(isValidPropertyKey(key), key).toBe(false);
  });
});

describe("frontmatter writer for properties", () => {
  const yaml = "title: Plan\n# keep me\nstatus: todo # inline\ndue date: 2026-11-21\nlist: [a, b]\nobj:\n  nested: 1\n";

  it("writes numbers and booleans unquoted, a string that looks like one quoted", () => {
    const out = editFrontmatterYaml(yaml, { rank: 3, done: true, code: "007" });
    expect(out).toBe(`${yaml}rank: 3\ndone: true\ncode: "007"\n`);
  });

  it("touches only the changed line; comments, other keys and nested maps stay byte-for-byte", () => {
    const out = editFrontmatterYaml(yaml, { status: "doing" });
    expect(out).toBe(yaml.replace("status: todo # inline", "status: doing # inline"));
  });

  it("edits keys with spaces or non-Latin letters, and keeps a flow list in flow style", () => {
    expect(editFrontmatterYaml(yaml, { "due date": "2026-12-01" })).toContain("due date: 2026-12-01\n");
    expect(editFrontmatterYaml(yaml, { list: ["a", "b", "c"] })).toContain("list: [a, b, c]\n");
    expect(editFrontmatterYaml("статус: новый\n", { "статус": "готово" })).toBe("статус: готово\n");
  });

  it("renames a key in place, keeping its value bytes and position", () => {
    const out = editFrontmatterYaml(yaml, {}, [{ from: "status", to: "state" }]);
    expect(out).toBe(yaml.replace("status: todo # inline", "state: todo # inline"));
    // Rename and then change the new key in the same edit.
    expect(editFrontmatterYaml(yaml, { state: "done" }, [{ from: "status", to: "state" }])).toContain("state: done # inline\n");
  });

  it("removes a key with its block (a block list included)", () => {
    const out = editFrontmatterYaml("a: 1\nitems:\n  - x\n  - y\nb: 2\n", { items: null });
    expect(out).toBe("a: 1\nb: 2\n");
  });
});

describe("type changes on a page's value (#qw4pcm2h review)", () => {
  it("knows when a value fits its type", async () => {
    const { propertyValueMatches } = await import("../src/properties");
    expect(propertyValueMatches("number", 2)).toBe(true);
    expect(propertyValueMatches("number", "2")).toBe(false);
    expect(propertyValueMatches("multitext", "Ann")).toBe(false);
    expect(propertyValueMatches("text", ["a"])).toBe(false);
    expect(propertyValueMatches("date", null)).toBe(true);
  });

  it("converts only cleanly, never losing anything", async () => {
    const { convertPropertyValue } = await import("../src/properties");
    expect(convertPropertyValue("number", "2")).toBe(2);
    expect(convertPropertyValue("checkbox", "true")).toBe(true);
    expect(convertPropertyValue("checkbox", "yes")).toBeUndefined();
    expect(convertPropertyValue("date", "2026-11-21T10:00")).toBe("2026-11-21");
    expect(convertPropertyValue("multitext", "Ann")).toEqual(["Ann"]);
    expect(convertPropertyValue("tags", "#launch")).toEqual(["launch"]);
    expect(convertPropertyValue("text", 2)).toBeUndefined(); // a number reads fine as text
    expect(convertPropertyValue("text", ["a", "b"])).toBeUndefined();
    expect(convertPropertyValue("number", "lots")).toBeUndefined();
    expect(convertPropertyValue("number", 2)).toBeUndefined(); // already fits
  });
});
