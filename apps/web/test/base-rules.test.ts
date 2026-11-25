import { describe, expect, it } from "vitest";
import { parseBase } from "@gumply/core";
import {
  baseSource,
  hasOtherGlobalFilters,
  parseRule,
  propertyRef,
  ruleToExpression,
  viewClauses,
  withClauses,
  withSource,
  type FilterRule,
} from "../src/bases/rules";

describe("filter rules ↔ Bases expressions", () => {
  it("names properties the way Obsidian reads them", () => {
    expect(propertyRef("note.status")).toBe("status");
    expect(propertyRef("note.due date")).toBe('note["due date"]');
    expect(propertyRef("note.file")).toBe('note["file"]');
    expect(propertyRef("file.name")).toBe("file.name");
    expect(propertyRef("formula.total")).toBe("formula.total");
  });

  const cases: [FilterRule, string, string][] = [
    [{ property: "note.status", op: "is", value: "Done" }, "text", 'status == "Done"'],
    [{ property: "note.status", op: "isNot", value: 'say "hi"' }, "text", 'status != "say \\"hi\\""'],
    [{ property: "note.title words", op: "contains", value: "plan" }, "text", 'note["title words"].contains("plan")'],
    [{ property: "note.tags", op: "notContains", value: "old" }, "tags", '!tags.contains("old")'],
    [{ property: "note.due", op: "empty", value: "" }, "date", "due.isEmpty()"],
    [{ property: "note.due", op: "notEmpty", value: "" }, "date", "!due.isEmpty()"],
    [{ property: "note.estimate", op: "gte", value: "3" }, "number", "estimate >= 3"],
    [{ property: "note.estimate", op: "lt", value: "2.5" }, "number", "estimate < 2.5"],
    [{ property: "note.due", op: "before", value: "2026-12-01" }, "date", 'due < date("2026-12-01")'],
    [{ property: "note.due", op: "after", value: "2026-12-01" }, "date", 'due > date("2026-12-01")'],
    [{ property: "note.done", op: "checked", value: "" }, "checkbox", "done == true"],
    [{ property: "note.done", op: "unchecked", value: "" }, "checkbox", "done != true"],
    [{ property: "file.name", op: "contains", value: "Q1" }, "file", 'file.name.contains("Q1")'],
  ];

  it.each(cases)("%o (%s) ↔ %s", (rule, type, expression) => {
    expect(ruleToExpression(rule, type)).toBe(expression);
    expect(parseRule(expression)).toEqual(rule);
  });

  it("leaves expressions it can't show as rules", () => {
    expect(parseRule("file.hasLink(this.file)")).toBeNull();
    expect(parseRule('status == "a" || status == "b"')).toBeNull();
    expect(parseRule("formula.days_left < 7 && done")).toBeNull();
    expect(parseRule('note == "x"')).toBeNull();
  });

  it("round-trips a view's clauses, keeping what it can't edit", () => {
    const base = parseBase(
      'views:\n  - type: table\n    name: T\n    filters:\n      and:\n        - status != "Done"\n        - file.hasLink(this.file)\n        - or:\n            - a\n            - b\n',
    );
    const view = base.views[0]!;
    const clauses = viewClauses(view);
    expect(clauses).toEqual([
      { rule: { property: "note.status", op: "isNot", value: "Done" } },
      { raw: "file.hasLink(this.file)" },
      { raw: { or: ["a", "b"] } },
    ]);
    expect(withClauses(view, clauses, () => "text").filters).toEqual(view.filters);
    expect(withClauses(view, [], () => "text").filters).toBeUndefined();
  });
});

describe("a base's source", () => {
  it("reads and replaces the folder or tag clause, keeping others", () => {
    const base = parseBase('filters:\n  and:\n    - file.inFolder("Projects")\n    - status != "x"\nviews: []\n');
    expect(baseSource(base)).toEqual({ kind: "folder", folder: "Projects" });
    expect(hasOtherGlobalFilters(base)).toBe(true);
    expect(withSource(base, { kind: "tag", tag: "#work" }).filters).toEqual({ and: ['file.hasTag("work")', 'status != "x"'] });
    expect(withSource(base, { kind: "all" }).filters).toEqual({ and: ['status != "x"'] });
  });

  it("adds a source to a base without one, and removes the filter when it was the only clause", () => {
    const empty = parseBase("views: []\n");
    expect(baseSource(empty)).toEqual({ kind: "all" });
    const withFolder = withSource(empty, { kind: "folder", folder: "Notes/2026" });
    expect(withFolder.filters).toEqual({ and: ['file.inFolder("Notes/2026")'] });
    expect(withSource(withFolder, { kind: "all" }).filters).toBeUndefined();
  });

  it("reads `file.folder == \"X\"` (the Notion import's rows folder) as that folder, and writes it back in the same form", () => {
    const notion = parseBase('filters:\n  and:\n    - file.folder == "Notion import/Tasks"\nviews: []\n');
    expect(baseSource(notion)).toEqual({ kind: "folder", folder: "Notion import/Tasks", direct: true });
    expect(hasOtherGlobalFilters(notion)).toBe(false);
    // Another folder keeps the direct form; switching to a tag or all replaces it.
    expect(withSource(notion, { kind: "folder", folder: "Other", direct: true }).filters).toEqual({ and: ['file.folder == "Other"'] });
    expect(withSource(notion, { kind: "tag", tag: "work" }).filters).toEqual({ and: ['file.hasTag("work")'] });
    expect(withSource(notion, { kind: "all" }).filters).toBeUndefined();
    // Spacing as Obsidian may write it, and quotes inside the name.
    expect(baseSource(parseBase('filters:\n  and:\n    - \'file.folder=="A \\"q\\" B"\'\nviews: []\n'))).toEqual({ kind: "folder", folder: 'A "q" B', direct: true });
    // Other comparisons on file.folder aren't a source.
    expect(baseSource(parseBase('filters:\n  and:\n    - file.folder != "X"\nviews: []\n'))).toEqual({ kind: "all" });
  });
});
