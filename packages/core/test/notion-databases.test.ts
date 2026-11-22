import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inferNotionColumn,
  notionBaseSource,
  notionPropertyKey,
  parseCsv,
  parseNotionDate,
  parseRelationCell,
} from "../src/notion-databases";
import { parse as parseYaml } from "yaml";
import { parseBase, parseFrontmatter } from "../src/index";

/** v0.8 B3 (#cwi22mc6, spec/notion-import §6): the database helpers. */

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED = join(here, "fixtures/notion/databases.expected/Notion import/Private & Shared/Projects");

describe("parseCsv", () => {
  it("reads Notion's CSV: BOM, CRLF, quoted commas, quotes and newlines, no final newline", () => {
    expect(parseCsv('﻿Name,Notes\r\nA,"x, ""y""\nz"\r\nB,')).toEqual([
      ["Name", "Notes"],
      ["A", 'x, "y"\nz'],
      ["B", ""],
    ]);
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parseNotionDate", () => {
  it("English dates and date-times; anything else is not a date", () => {
    expect(parseNotionDate("November 3, 2026")).toEqual({ type: "date", iso: "2026-11-03" });
    expect(parseNotionDate("November 4, 2026 4:05 PM")).toEqual({ type: "datetime", iso: "2026-11-04T16:05" });
    expect(parseNotionDate("November 5, 2026 12:30 AM")).toEqual({ type: "datetime", iso: "2026-11-05T00:30" });
    expect(parseNotionDate("February 30, 2026")).toBeNull();
    expect(parseNotionDate("3 ноября 2026 г.")).toBeNull();
    expect(parseNotionDate("November 3, 2026 → November 5, 2026")).toBeNull();
  });
});

describe("notionPropertyKey", () => {
  it("cleans names to valid keys, renames Gumply's own keys and Notion's time columns, numbers collisions", () => {
    const used = new Set<string>();
    expect(["Priority (1–5)", "Done?", "Notes", "Notes!", "???", "Created time", "Last edited time", "title", "Status"].map((name) => notionPropertyKey(name, used))).toEqual([
      "Priority 1 5",
      "Done",
      "Notes",
      "Notes 2",
      "property",
      "created-notion",
      "edited-notion",
      "title-notion",
      "Status",
    ]);
  });
});

describe("inferNotionColumn", () => {
  it("a type only when every non-empty value fits it", () => {
    expect(inferNotionColumn("N", ["1", "-2.5", ""])).toBe("number");
    expect(inferNotionColumn("N", ["1", "0042"])).toBe("text");
    expect(inferNotionColumn("N", ["1,234"])).toBe("text");
    expect(inferNotionColumn("Done", ["Yes", "No", ""])).toBe("checkbox");
    expect(inferNotionColumn("Due", ["November 3, 2026", ""])).toBe("date");
    expect(inferNotionColumn("At", ["November 3, 2026 9:00 AM"])).toBe("datetime");
    expect(inferNotionColumn("Mixed", ["November 3, 2026", "November 3, 2026 9:00 AM"])).toBe("text");
    expect(inferNotionColumn("Span", ["November 3, 2026 → November 5, 2026"])).toBe("text");
    expect(inferNotionColumn("Tags", ["red, blue", "blue"])).toBe("multitext");
    expect(inferNotionColumn("Words", ["a, b", "c, d", "e"])).toBe("multitext");
    expect(inferNotionColumn("Prose", ["Hello, world. This is a sentence.", "Fine"])).toBe("text");
    expect(inferNotionColumn("Owner", [`Ada (https://www.notion.so/Ada-${"b".repeat(32)}?pvs=21)`])).toBe("relation");
    expect(inferNotionColumn("Empty", ["", " "])).toBe("text");
  });

  it("relation cells: each item's id is the last 32-hex run (the `%20` before it is hex too)", () => {
    const id = `${"0".repeat(30)}b1`;
    expect(parseRelationCell(`Bob (../People/Bob%20${id}.md), Ada (https://www.notion.so/Ada-${"a".repeat(32)})`)).toEqual([
      { title: "Bob", ref: `../People/Bob%20${id}.md`, id },
      { title: "Ada", ref: `https://www.notion.so/Ada-${"a".repeat(32)}`, id: "a".repeat(32) },
    ]);
    expect(parseRelationCell("Just text, here")).toBeNull();
  });
});

describe("the .base is written in Obsidian's own key order (#hmg9zbd9)", () => {
  it("a Kanban view's keys come in the order Obsidian 1.14.4 writes them, so it doesn't rewrite the file on first open", () => {
    const keysOf = (source: string, type: string) => {
      const view = (parseYaml(source) as { views: Array<Record<string, unknown>> }).views.find((item) => item.type === type)!;
      return Object.keys(view);
    };
    const obsidian = keysOf(readFileSync(join(here, "fixtures/bases/all-settings.obsidian-1.14.4.base"), "utf8"), "kanban");
    const ours = keysOf(notionBaseSource({ rowsFolder: "R", columns: ["a"], kanban: { key: "s", groups: ["x"], columns: ["a"] } }), "kanban");
    expect(ours).toEqual(obsidian.filter((key) => ours.includes(key)));
    expect(ours).toEqual(["type", "name", "groupBy", "groupOrder", "order"]);
  });
});

describe("the generated files read back", () => {
  it("each .base parses, filters the rows folder and keeps the column order", () => {
    const tasks = parseBase(readFileSync(join(EXPECTED, "Tasks.base"), "utf8"));
    expect(tasks.filters).toEqual({ and: ['file.folder == "Notion import/Private & Shared/Projects/Tasks"'] });
    expect(tasks.views.map((view) => view.type)).toEqual(["table", "kanban"]);
    expect(tasks.views[0]!.order).toEqual(["file.name", "Due", "Priority 1 5", "Done", "Tags", "Owner", "Notes"]);
    expect(tasks.views[1]).toMatchObject({ groupBy: { property: "Status", direction: "ASC" }, groupOrder: ["Todo", "Doing", "Done"] });
    expect(parseBase(notionBaseSource({ rowsFolder: 'A "quoted": folder', columns: ["x"], kanban: null })).filters).toEqual({
      and: ['file.folder == "A \\"quoted\\": folder"'],
    });
  });

  it("a row page's frontmatter is YAML with typed values (as Obsidian reads it)", () => {
    const text = readFileSync(join(EXPECTED, "Tasks/Write spec.md"), "utf8");
    const { content } = parseFrontmatter(text);
    const yaml = parseYaml(text.split("---\n")[1]!) as Record<string, unknown>;
    expect(yaml).toMatchObject({
      Status: "Todo",
      Due: "2026-11-03",
      "Priority 1 5": 1,
      Done: true,
      Tags: ["red", "blue"],
      Owner: ["[[Ada]]"],
      Code: "0042",
      Notes: 'Line one, with a comma\nand "quotes"',
    });
    expect(content).toBe("First draft.");
  });
});
