import { describe, expect, it } from "vitest";
import { nextOptionColor, parseBase, selectSettings, selectedValues, updateBaseSource, withSelectSettings, type BaseConfig } from "../src/index";

/** #7prbquxu phase 3 (spec/database-tables §6): Select options in the base. Invented data. */

const SOURCE = `gumply:
  rows: Tasks
properties:
  note.status:
    displayName: Status
    gumplyType: select
    gumplyOptions:
      - value: Todo
        color: gray
      - value: Doing
        color: blue
views:
  - type: table
    name: Table
`;

describe("selectSettings", () => {
  it("reads the kind and the options, whatever the key order (Obsidian moves displayName after ours)", () => {
    const moved = SOURCE.replace("    displayName: Status\n", "").replace("        color: blue\n", "        color: blue\n    displayName: Status\n");
    for (const source of [SOURCE, moved]) {
      expect(selectSettings(parseBase(source), "status")).toEqual({
        kind: "select",
        options: [
          { value: "Todo", color: "gray" },
          { value: "Doing", color: "blue" },
        ],
      });
    }
  });

  it("takes the short id form too; an unknown colour reads gray; empty and repeated values are dropped", () => {
    const config: BaseConfig = {
      views: [],
      properties: { skills: { gumplyType: "multiselect", gumplyOptions: [{ value: "Go", color: "teal" }, { value: "" }, { value: "Go" }, "Rust", 7] } },
    };
    expect(selectSettings(config, "skills")).toEqual({
      kind: "multiselect",
      options: [
        { value: "Go", color: "gray" },
        { value: "Rust", color: "gray" },
        { value: "7", color: "gray" },
      ],
    });
  });

  it("is null for a key that isn't a Select", () => {
    expect(selectSettings(parseBase(SOURCE), "due")).toBeNull();
    expect(selectSettings({ views: [], properties: { "note.x": { gumplyType: "text" } } }, "x")).toBeNull();
  });
});

describe("withSelectSettings", () => {
  it("writes our keys next to the entry's own, and only those lines change in the file", () => {
    const config = parseBase(SOURCE);
    const next = withSelectSettings(config, "status", {
      kind: "select",
      options: [
        { value: "Todo", color: "gray" },
        { value: "Doing", color: "blue" },
        { value: "Done", color: "green" },
      ],
    });
    expect(updateBaseSource(SOURCE, next)).toBe(SOURCE.replace("        color: blue\n", "        color: blue\n      - value: Done\n        color: green\n"));
  });

  it("adds a new entry as note.<key>, and removing the settings keeps displayName", () => {
    const added = withSelectSettings({ views: [] }, "priority", { kind: "select", options: [{ value: "High", color: "red" }] });
    expect(added.properties).toEqual({ "note.priority": { gumplyType: "select", gumplyOptions: [{ value: "High", color: "red" }] } });
    const removed = withSelectSettings(parseBase(SOURCE), "status", null);
    expect(removed.properties).toEqual({ "note.status": { displayName: "Status" } });
    expect(withSelectSettings(added, "priority", null).properties).toBeUndefined();
  });
});

describe("helpers", () => {
  it("nextOptionColor takes the first unused colour after gray", () => {
    expect(nextOptionColor([])).toBe("brown");
    expect(nextOptionColor([{ value: "a", color: "brown" }, { value: "b", color: "orange" }])).toBe("yellow");
  });

  it("selectedValues reads a Select's text or a Multi-select's list", () => {
    expect(selectedValues("Todo")).toEqual(["Todo"]);
    expect(selectedValues(["Go", "Rust", 3])).toEqual(["Go", "Rust", "3"]);
    expect(selectedValues("")).toEqual([]);
    expect(selectedValues(null)).toEqual([]);
  });
});

describe("a Select made with no options yet (#7prbquxu, \"+\" Select)", () => {
  it("writes no empty list, so the first option added is written as a block list like the others", () => {
    const source = "views:\n  - type: table\n    name: Table\n";
    const empty = updateBaseSource(source, withSelectSettings(parseBase(source), "stage", { kind: "select", options: [] }));
    expect(empty).not.toContain("[]");
    expect(selectSettings(parseBase(empty), "stage")).toEqual({ kind: "select", options: [] });
    const one = updateBaseSource(empty, withSelectSettings(parseBase(empty), "stage", { kind: "select", options: [{ value: "Todo", color: "brown" }] }));
    expect(one).toContain("    gumplyOptions:\n      - value: Todo\n        color: brown\n");
  });
});
