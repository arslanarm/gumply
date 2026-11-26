import { describe, expect, it } from "vitest";
import type { BaseConfig } from "@gumply/core";
import { dropKeyFromConfig, renameKeyInConfig } from "../src/bases/columns";

/** #7prbquxu: renaming or deleting a property of an owned database follows it through the base file. */
const config: BaseConfig = {
  gumply: { rows: "People" },
  properties: { "note.role": { displayName: "Job" }, age: { gumplyWeekStart: 1 } },
  views: [
    { type: "table", name: "Table", order: ["file.name", "role", "note.age"], sort: [{ property: "role", direction: "ASC" }] },
    { type: "kanban", name: "Board", groupBy: { property: "note.role", direction: "ASC" }, order: ["file.name"] },
  ],
};

describe("renameKeyInConfig", () => {
  it("renames the key in every view's columns, sort and grouping, and in properties, keeping each id's form", () => {
    const next = renameKeyInConfig(config, "role", "job");
    expect(next.views[0]!.order).toEqual(["file.name", "job", "note.age"]);
    expect(next.views[0]!.sort).toEqual([{ property: "job", direction: "ASC" }]);
    expect(next.views[1]!.groupBy).toEqual({ property: "note.job", direction: "ASC" });
    expect(next.properties).toEqual({ "note.job": { displayName: "Job" }, age: { gumplyWeekStart: 1 } });
    expect(next.gumply).toEqual({ rows: "People" });
  });

  it("leaves other keys and a base without the key as they were", () => {
    expect(renameKeyInConfig(config, "height", "tall")).toEqual(config);
  });
});

describe("dropKeyFromConfig", () => {
  it("drops the key from columns, sort, grouping and properties", () => {
    const next = dropKeyFromConfig(config, "role");
    expect(next.views[0]!.order).toEqual(["file.name", "note.age"]);
    expect(next.views[0]!.sort).toEqual([]);
    expect(next.views[1]).not.toHaveProperty("groupBy");
    expect(next.properties).toEqual({ age: { gumplyWeekStart: 1 } });
  });
});
