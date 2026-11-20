import { describe, expect, it } from "vitest";
import { filterSlashItems, SLASH_ITEMS } from "../src/editor/slash-items.js";

const keys = (items: readonly { key: string }[]): string[] => items.map((item) => item.key);

describe("filterSlashItems", () => {
  it("returns every block for an empty query, in menu order", () => {
    expect(keys(filterSlashItems(SLASH_ITEMS, ""))).toEqual([
      "heading-1",
      "heading-2",
      "heading-3",
      "bullet-list",
      "ordered-list",
      "todo",
      "quote",
      "code",
      "table",
      "emoji",
      "image",
      "file",
      "divider",
    ]);
  });

  it("matches headings by title and h1/h2/h3 aliases", () => {
    expect(keys(filterSlashItems(SLASH_ITEMS, "head"))).toEqual([
      "heading-1",
      "heading-2",
      "heading-3",
    ]);
    expect(keys(filterSlashItems(SLASH_ITEMS, "h2"))).toEqual(["heading-2"]);
  });

  it("matches keywords, not just titles", () => {
    expect(keys(filterSlashItems(SLASH_ITEMS, "task"))).toEqual(["todo"]);
    expect(keys(filterSlashItems(SLASH_ITEMS, "checkbox"))).toEqual(["todo"]);
    expect(keys(filterSlashItems(SLASH_ITEMS, "hr"))).toEqual(["divider"]);
    expect(keys(filterSlashItems(SLASH_ITEMS, "photo"))).toEqual(["image"]);
    expect(keys(filterSlashItems(SLASH_ITEMS, "attachment"))).toEqual(["image", "file"]);
  });

  it("is case-insensitive and trims the query", () => {
    expect(keys(filterSlashItems(SLASH_ITEMS, "  CODE "))).toEqual(["code"]);
  });

  it("returns nothing for unknown queries", () => {
    expect(filterSlashItems(SLASH_ITEMS, "zzz")).toEqual([]);
  });
});
