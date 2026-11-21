import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsupportedError,
  evaluateExpression,
  newBaseSource,
  parseBase,
  runBaseView,
  typedProperties,
  updateBaseSource,
  type BaseSourceRow,
  type EvalContext,
  type FileInfo,
} from "../src/index.js";

/** A base in the shape Obsidian writes (spec/api-bases). */
const OBSIDIAN_BASE = `# Project tracker
filters:
  and:
    - file.inFolder("Projects")
    - 'status != "archived"'
formulas:
  days_left: (due - today()) / 86400000
properties:
  note.status:
    displayName: Status
views:
  - type: table
    name: All projects
    order:
      - file.name
      - status
      - due
    sort:
      - property: due
        direction: ASC
    columnSize:
      note.status: 140
  - type: kanban
    name: Board
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - Planned
      - In progress
      - Done
  - type: some-plugin-view
    name: Plugin view
    pluginSetting: { a: 1, b: [x, y] } # kept as written
`;

const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime();
const TYPES = new Map([
  ["priority", "number"],
  ["status", "text"],
  ["due", "date"],
  ["price", "number"],
  ["done", "checkbox"],
  ["tags", "tags"],
]);

function file(path: string, props: Record<string, unknown> = {}, extra: Partial<FileInfo> = {}): FileInfo {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return {
    path,
    title: name,
    ctime: NOW - 86_400_000,
    mtime: NOW,
    tags: (props.tags as string[] | undefined) ?? [],
    links: [],
    props: typedProperties(Object.entries(props), TYPES),
    ...extra,
  };
}

function row(path: string, props: Record<string, unknown> = {}, extra: Partial<FileInfo> = {}): BaseSourceRow {
  const info = file(path, props, extra);
  return { id: path.replace(/\.md$/, ""), kind: "page", title: info.title, updated: new Date(NOW).toISOString(), file: info };
}

function ctx(info: FileInfo, more: Partial<EvalContext> = {}): EvalContext {
  return { file: info, now: NOW, ...more };
}

const evalOn = (source: string, props: Record<string, unknown> = {}, more: Partial<EvalContext> = {}) =>
  evaluateExpression(source, ctx(file("Projects/Plan.md", props), more));

describe("parseBase", () => {
  it("reads Obsidian's keys and keeps unknown ones", () => {
    const config = parseBase(OBSIDIAN_BASE);
    expect(config.filters).toEqual({ and: ['file.inFolder("Projects")', 'status != "archived"'] });
    expect(config.formulas).toEqual({ days_left: "(due - today()) / 86400000" });
    expect(config.properties).toEqual({ "note.status": { displayName: "Status" } });
    expect(config.views.map((view) => [view.type, view.name])).toEqual([
      ["table", "All projects"],
      ["kanban", "Board"],
      ["some-plugin-view", "Plugin view"],
    ]);
    expect(config.views[0]!.sort).toEqual([{ property: "due", direction: "ASC" }]);
    expect(config.views[0]!.columnSize).toEqual({ "note.status": 140 });
    expect(config.views[1]!.groupOrder).toEqual(["Planned", "In progress", "Done"]);
    expect(config.views[2]!.pluginSetting).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("fills in a missing view name and type, and reads an empty file", () => {
    expect(parseBase("views:\n  - order: [file.name]\n").views[0]).toMatchObject({ type: "table", name: "View 1" });
    expect(parseBase("")).toEqual({ views: [] });
  });

  it("rejects what isn't a base", () => {
    expect(() => parseBase("- a\n- b\n")).toThrow();
    expect(() => parseBase("views: [\n")).toThrow();
  });
});

describe("updateBaseSource", () => {
  it("returns the source untouched when nothing changed", () => {
    expect(updateBaseSource(OBSIDIAN_BASE, parseBase(OBSIDIAN_BASE))).toBe(OBSIDIAN_BASE);
    // Defaults parseBase adds aren't a change either.
    const unnamed = "views:\n  - order: [file.name]\n";
    expect(updateBaseSource(unnamed, parseBase(unnamed))).toBe(unnamed);
  });

  it("changes one value and keeps comments, order, flow style and unknown views", () => {
    const config = parseBase(OBSIDIAN_BASE);
    config.views[0]!.sort = [{ property: "due", direction: "DESC" }];
    const written = updateBaseSource(OBSIDIAN_BASE, config);
    expect(written).toBe(OBSIDIAN_BASE.replace("direction: ASC\n    columnSize", "direction: DESC\n    columnSize"));
  });

  it("adds and removes a filter line without touching the rest", () => {
    const config = parseBase(OBSIDIAN_BASE);
    (config.filters as { and: string[] }).and.push('file.hasTag("work")');
    const added = updateBaseSource(OBSIDIAN_BASE, config);
    expect(added).toBe(
      OBSIDIAN_BASE.replace(`    - 'status != "archived"'\n`, `    - 'status != "archived"'\n    - file.hasTag("work")\n`),
    );
    const back = parseBase(added);
    (back.filters as { and: string[] }).and.pop();
    expect(updateBaseSource(added, back)).toBe(OBSIDIAN_BASE);
  });

  it("adds a view at the end and keeps a moved view's comments", () => {
    const config = parseBase(OBSIDIAN_BASE);
    config.views.push({ type: "calendar", name: "Due dates", dateProperty: "note.due" });
    const added = updateBaseSource(OBSIDIAN_BASE, config);
    expect(added.startsWith(OBSIDIAN_BASE)).toBe(true);
    expect(added.slice(OBSIDIAN_BASE.length)).toBe("  - type: calendar\n    name: Due dates\n    dateProperty: note.due\n");

    const moved = parseBase(OBSIDIAN_BASE);
    moved.views = [moved.views[2]!, moved.views[0]!, moved.views[1]!];
    const text = updateBaseSource(OBSIDIAN_BASE, moved);
    expect(text).toContain("# kept as written");
    expect(parseBase(text).views.map((view) => view.name)).toEqual(["Plugin view", "All projects", "Board"]);
  });

  it("writes filter values with quotes and backslashes so they read back the same", () => {
    const config = parseBase(OBSIDIAN_BASE);
    const tricky = 'title == "say \\"hi\\" \\\\ there" && x != \'it\'\'s\'';
    (config.filters as { and: string[] }).and = [tricky, "a: b # not a comment", "- dash"];
    const written = updateBaseSource(OBSIDIAN_BASE, config);
    expect(parseBase(written).filters).toEqual({ and: [tricky, "a: b # not a comment", "- dash"] });
  });

  it("keeps CRLF line endings", () => {
    const crlf = OBSIDIAN_BASE.replace(/\n/g, "\r\n");
    const config = parseBase(crlf);
    config.views[0]!.name = "Projects";
    const written = updateBaseSource(crlf, config);
    expect(written).toBe(crlf.replace("name: All projects", "name: Projects"));
  });

  it("creates a new base that Obsidian and Gumply read the same way", () => {
    expect(newBaseSource({ folder: "Projects/Q1" })).toBe(
      'filters:\n  and:\n    - file.inFolder("Projects/Q1")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n',
    );
    expect(parseBase(newBaseSource({ tag: "#work" })).filters).toEqual({ and: ['file.hasTag("work")'] });
    expect(parseBase(newBaseSource()).filters).toBeUndefined();
  });
});

describe("expressions", () => {
  it("evaluates operators with JavaScript-like precedence", () => {
    expect(evalOn("1 + 2 * 3")).toBe(7);
    expect(evalOn("(1 + 2) * 3")).toBe(9);
    expect(evalOn("10 % 4 == 2 && !false")).toBe(true);
    expect(evalOn('"a" + 1')).toBe("a1");
    expect(evalOn("-price + 1", { price: 4 })).toBe(-3);
    expect(evalOn("1 / 0")).toBe(null);
  });

  it("reads note properties bare, as note.x and note[\"x y\"]", () => {
    const props = { status: "Done", "due date": "2026-12-01", price: 12 };
    expect(evalOn('status == "Done"', props)).toBe(true);
    expect(evalOn('note.status != "Done"', props)).toBe(false);
    expect(evalOn('note["due date"]', props)).toBe("2026-12-01");
    expect(evalOn("price > 10 && price <= 12", props)).toBe(true);
    expect(evalOn("missing == null", props)).toBe(true);
    expect(evalOn("missing.isEmpty()", props)).toBe(true);
  });

  it("knows file fields and functions", () => {
    const info = file("Projects/Q1/Plan.md", { tags: ["work/client", "urgent"] }, { links: ["Notes/Meeting.md"] });
    const run = (source: string) => evaluateExpression(source, ctx(info));
    expect(run("file.name")).toBe("Plan.md");
    expect(run("file.basename")).toBe("Plan");
    expect(run("file.folder")).toBe("Projects/Q1");
    expect(run("file.ext")).toBe("md");
    expect(run('file.inFolder("Projects")')).toBe(true);
    expect(run('file.inFolder("Proj")')).toBe(false);
    expect(run('file.hasTag("work")')).toBe(true);
    expect(run('file.hasTag("#urgent", "nope")')).toBe(true);
    expect(run('file.hasTag("client")')).toBe(false);
    expect(run('file.hasLink("Meeting")')).toBe(true);
    expect(run('file.hasLink("[[Notes/Meeting]]")')).toBe(true);
    expect(run('file.hasProperty("tags")')).toBe(true);
  });

  it("compares and shifts dates", () => {
    const props = { due: "2026-11-25" };
    expect(evalOn("due > today()", props)).toBe(true);
    expect(evalOn('due < today() + "1w"', props)).toBe(true);
    expect(evalOn('due < today() + "2d"', props)).toBe(false);
    expect(evalOn("due.year", props)).toBe(2026);
    expect(evalOn('due.format("D MMM YYYY [at] dddd")', props)).toBe("25 Nov 2026 at Wednesday");
    expect(evalOn('date("2026-11-21") == today()')).toBe(true);
    expect(evalOn('(date("2026-11-23") - today()) / 86400000')).toBe(2);
    expect(evalOn('today() + "1M"')).toMatchObject({ $t: "date", ms: new Date(2026, 11, 21).getTime() });
  });

  it("has if(), list methods and lambdas", () => {
    const props = { tags: ["a", "b", "c"], price: 5 };
    expect(evalOn('if(price > 3, "big", "small")', props)).toBe("big");
    expect(evalOn('tags.contains("b")', props)).toBe(true);
    expect(evalOn('tags.containsAll("a", "c")', props)).toBe(true);
    expect(evalOn('tags.filter(value != "b").join("-")', props)).toBe("a-c");
    expect(evalOn("[1, 2, 3].map(value * 2)")).toEqual([2, 4, 6]);
    expect(evalOn("[1, 2, 3].reduce(acc + value, 0)")).toBe(6);
    expect(evalOn("tags.length", props)).toBe(3);
    expect(evalOn('"Hello".lower().startsWith("he")')).toBe(true);
    expect(evalOn("(2.345).round(2)")).toBe(2.35);
  });

  it("knows this (the base, or the page it's embedded in)", () => {
    const host = file("Meetings/Weekly.md", { project: "Gumply" });
    const info = file("Notes/Plan.md", { project: "Gumply" }, { links: ["Meetings/Weekly.md"] });
    const run = (source: string) => evaluateExpression(source, ctx(info, { thisFile: host }));
    expect(run("file.hasLink(this.file)")).toBe(true);
    expect(run("project == this.project")).toBe(true);
    expect(run("this.file.name")).toBe("Weekly.md");
  });

  it("reports what it can't evaluate instead of guessing", () => {
    expect(() => evalOn("file.backlinks")).toThrow(UnsupportedError);
    expect(() => evalOn("someFunction(1)")).toThrow(UnsupportedError);
    expect(() => evalOn('"x".frobnicate()')).toThrow(UnsupportedError);
    expect(() => evalOn("a ==")).toThrow(UnsupportedError);
    expect(() => evalOn("'unclosed")).toThrow(UnsupportedError);
  });

  it("is inert for prototype and code-injection attempts", () => {
    const props = { status: "x" };
    for (const source of [
      'constructor.constructor("return process")()',
      'status.constructor.constructor("return process")()',
      "__proto__",
      "note.__proto__",
      'note["__proto__"]',
      "note.constructor",
      "file.constructor",
      "this.constructor",
      'file["constructor"]',
      "toString.call(1)",
      '[].constructor.constructor("x")()',
      "process.exit(1)",
      'require("fs")',
      'import("fs")',
      "globalThis",
      "eval('1')",
    ]) {
      let result: unknown;
      try {
        result = evalOn(source, props);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedError);
        continue;
      }
      // A plain property lookup that finds nothing.
      expect(result, source).toBe(null);
    }
    // Nothing leaked onto the prototypes.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses absurd nesting rather than overflowing the stack", () => {
    expect(() => evalOn(`${"(".repeat(500)}1${")".repeat(500)}`)).toThrow(UnsupportedError);
  });
});

describe("runBaseView", () => {
  const rows = [
    row("Projects/Alpha.md", { status: "Planned", due: "2026-12-01", price: 10 }),
    row("Projects/Beta.md", { status: "Done", due: "2026-11-01", price: 20 }),
    row("Projects/Gamma.md", { status: "In progress", price: 5 }),
    row("Projects/Old.md", { status: "archived", due: "2025-01-01" }),
    row("Elsewhere/Delta.md", { status: "Planned", due: "2026-11-30" }),
  ];
  const config = parseBase(OBSIDIAN_BASE);

  it("filters, sorts (empty last) and returns the view's columns", () => {
    const result = runBaseView({ config, rows, types: TYPES, now: NOW });
    expect(result.view).toBe("All projects");
    expect(result.rows.map((r) => r.title)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(result.columns).toEqual([
      { id: "file.name", type: "file", editable: false },
      { id: "note.status", displayName: "Status", type: "text", editable: true },
      { id: "note.due", type: "date", editable: true },
    ]);
    expect(result.rows[0]!.values).toEqual({ "file.name": "Beta.md", "note.status": "Done", "note.due": "2026-11-01" });
    expect(result.total).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it("groups in groupOrder for a kanban view", () => {
    const result = runBaseView({ config, view: "Board", rows, types: TYPES, now: NOW });
    expect(result.type).toBe("kanban");
    expect(result.groups!.map((group) => [group.label, group.rows.map((i) => result.rows[i]!.title)])).toEqual([
      ["Planned", ["Alpha"]],
      ["In progress", ["Gamma"]],
      ["Done", ["Beta"]],
    ]);
  });

  it("groups by value with empty last when there's no groupOrder", () => {
    const grouped = parseBase("views:\n  - type: list\n    name: L\n    groupBy:\n      property: due\n      direction: DESC\n");
    const result = runBaseView({ config: grouped, rows: rows.slice(0, 3), types: TYPES, now: NOW });
    expect(result.groups!.map((group) => group.label)).toEqual(["2026-12-01", "2026-11-01", ""]);
  });

  it("evaluates formulas, limit and summaries", () => {
    const base = parseBase(
      [
        "formulas:",
        "  double: price * 2",
        "  loop: formula.loop + 1",
        "summaries:",
        "  spread: values.length",
        "views:",
        "  - type: table",
        "    name: T",
        "    limit: 2",
        "    order: [file.name, formula.double, formula.loop]",
        "    sort: [{ property: price, direction: DESC }]",
        "    summaries:",
        "      formula.double: Sum",
        "      file.name: spread",
      ].join("\n"),
    );
    const result = runBaseView({ config: base, rows: rows.slice(0, 3), types: TYPES, now: NOW });
    expect(result.rows.map((r) => [r.title, r.values["formula.double"], r.values["formula.loop"]])).toEqual([
      ["Beta", 40, null],
      ["Alpha", 20, null],
    ]);
    expect(result.total).toBe(3);
    expect(result.summaries).toEqual({ "formula.double": "60", "file.name": "2" });
    expect(result.warnings).toEqual(["formula.loop + 1: formula.loop refers to itself"]);
  });

  it("skips a filter it can't evaluate (and says so) instead of hiding rows", () => {
    const base = parseBase('filters:\n  and:\n    - file.backlinks.length > 2\n    - status == "Planned"\nviews:\n  - type: table\n    name: T\n');
    const result = runBaseView({ config: base, rows, types: TYPES, now: NOW });
    expect(result.rows.map((r) => r.title)).toEqual(["Alpha", "Delta"]);
    expect(result.warnings).toEqual(["file.backlinks.length > 2: file.backlinks"]);
  });

  it("handles or/not filter trees", () => {
    const base = parseBase(
      'filters:\n  or:\n    - status == "Done"\n    - not:\n        - file.inFolder("Projects")\nviews:\n  - type: table\n    name: T\n',
    );
    expect(runBaseView({ config: base, rows, types: TYPES, now: NOW }).rows.map((r) => r.title)).toEqual(["Beta", "Delta"]);
  });

  it("runs 2,000 pages quickly", () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      row(`Projects/Page ${i}.md`, { status: ["Planned", "Done", "In progress"][i % 3], due: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`, price: i }),
    );
    const started = performance.now();
    const result = runBaseView({ config, rows: many, types: TYPES, now: NOW });
    expect(result.rows).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("files Obsidian 1.14.4 wrote (@opus-hunter's fixtures)", () => {
  const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "bases", name), "utf8");
  const ALL = fixture("all-settings.obsidian-1.14.4.base");
  const projects = ["todo", "doing", "done", "todo"].map((status, i) =>
    row(`Projects/P${i}.md`, { status, due: `2026-12-0${i + 1}`, priority: i + 1 }),
  );

  it("reads every view and runs it, with property ids in both forms", () => {
    const config = parseBase(ALL);
    expect(config.views.map((view) => view.type)).toEqual(["table", "cards", "list", "kanban"]);
    const table = runBaseView({ config, rows: projects, types: TYPES, now: NOW });
    expect(table.rows.map((r) => r.title)).toEqual(["P3", "P2", "P1", "P0"]);
    expect(table.columns.map((column) => column.id)).toEqual(["file.name", "note.status", "note.due", "note.priority"]);
    expect(table.summaries).toEqual({ "note.priority": "2.5" });
    const kanban = runBaseView({ config, view: "Kanban", rows: projects, types: TYPES, now: NOW });
    expect(kanban.groups!.map((group) => [group.label, group.rows.length])).toEqual([
      ["todo", 2],
      ["doing", 1],
      ["done", 1],
    ]);
    const cards = runBaseView({ config, view: "Cards", rows: projects, types: TYPES, now: NOW });
    // The cover image property is fetched for the layout.
    expect(Object.keys(cards.rows[0]!.values)).toContain("note.cover");
  });

  it("an unrelated edit changes only its own line", () => {
    const config = parseBase(ALL);
    expect(updateBaseSource(ALL, config)).toBe(ALL);
    config.views[1]!.name = "Gallery";
    expect(updateBaseSource(ALL, config)).toBe(ALL.replace("    name: Cards\n", "    name: Gallery\n"));
    const sorted = parseBase(ALL);
    sorted.views[0]!.sort = [{ property: "due", direction: "ASC" }];
    expect(updateBaseSource(ALL, sorted)).toBe(ALL.replace("        direction: DESC\n", "        direction: ASC\n"));
  });

  it("keeps our calendar view and unknown keys after Obsidian re-saved the file", () => {
    const after = fixture("with-calendar.after-obsidian-edit.base");
    const config = parseBase(after);
    expect(config.gumply).toEqual({ version: 1, note: "unknown top-level key" });
    expect(config.views[0]).toMatchObject({ type: "calendar", dateProperty: "note.due", endDateProperty: "note.end", gumplyWeekStart: "monday" });
    config.views[1]!.limit = 20;
    expect(updateBaseSource(after, config)).toBe(after.replace("    limit: 50\n", "    limit: 20\n"));
  });
});
