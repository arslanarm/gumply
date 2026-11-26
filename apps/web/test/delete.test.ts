import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  databaseDeleteAsk,
  deleteDialogBody,
  directSubPages,
  focusAfterDelete,
  folderContents,
  folderDeleteBody,
  subtreePages,
} from "../src/lib/delete.js";

function meta(id: string, title: string, parentId: string | null = null): PageMeta {
  return {
    id,
    title,
    tags: [],
    parentId,
    childCount: 0,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  };
}

const pages = [
  meta("projects", "Projects"),
  meta("projects/banana", "Banana", "projects"),
  meta("projects/cherry", "Cherry", "projects"),
  meta("projects/cherry/detail", "Detail", "projects/cherry"),
  meta("projects/apple", "Apple", "projects"),
  meta("zeta", "Zeta"),
];

describe("directSubPages", () => {
  it("counts direct sub-pages only", () => {
    expect(directSubPages(pages, "projects").map((page) => page.id).sort()).toEqual([
      "projects/apple",
      "projects/banana",
      "projects/cherry",
    ]);
    expect(directSubPages(pages, "projects/cherry").map((page) => page.id)).toEqual([
      "projects/cherry/detail",
    ]);
    expect(directSubPages(pages, "zeta")).toEqual([]);
  });
});

describe("subtreePages", () => {
  it("returns the page and every descendant, parents first", () => {
    expect(subtreePages(pages, "projects").map((page) => page.id)).toEqual([
      "projects",
      "projects/banana",
      "projects/cherry",
      "projects/apple",
      "projects/cherry/detail",
    ]);
  });

  it("returns an empty list for unknown ids", () => {
    expect(subtreePages(pages, "missing")).toEqual([]);
  });
});

describe("deleteDialogBody", () => {
  it("uses the singular for one sub-page", () => {
    expect(deleteDialogBody(1)).toBe("Its 1 sub-page will be deleted too.");
  });

  it("uses the plural otherwise", () => {
    expect(deleteDialogBody(2)).toBe("Its 2 sub-pages will be deleted too.");
    expect(deleteDialogBody(12)).toBe("Its 12 sub-pages will be deleted too.");
  });
});

describe("focusAfterDelete", () => {
  it("prefers the next sibling in tree order", () => {
    expect(focusAfterDelete(pages, "projects/banana")).toBe("projects/cherry");
  });

  it("falls back to the previous sibling for the last row", () => {
    expect(focusAfterDelete(pages, "projects/cherry")).toBe("projects/banana");
  });

  it("returns null when there is no sibling", () => {
    expect(focusAfterDelete([meta("solo", "Solo")], "solo")).toBeNull();
  });

  it("returns null for unknown ids", () => {
    expect(focusAfterDelete(pages, "missing")).toBeNull();
  });
});

describe("deleting a plain folder (D33)", () => {
  it("counts pages, boards and other files at any depth", () => {
    const folder = (id: string, parentId: string | null = null, otherFiles = 0): PageMeta => ({
      ...meta(id, id, parentId),
      kind: "folder",
      otherFiles,
    });
    const pages = [
      folder("Recipes", null, 5),
      meta("Recipes/Soup", "Soup", "Recipes"),
      { ...meta("Recipes/Map.canvas", "Map", "Recipes"), kind: "whiteboard" as const },
      folder("Recipes/Sweet", "Recipes"),
      meta("Recipes/Sweet/Cake", "Cake", "Recipes/Sweet"),
      meta("Recipes/Sweet/Pie", "Pie", "Recipes/Sweet"),
      meta("Other", "Other"),
    ];
    expect(folderContents(pages, "Recipes")).toEqual({ pages: 3, boards: 1, otherFiles: 5 });
    expect(folderDeleteBody({ pages: 3, boards: 1, otherFiles: 5 })).toBe(
      "Its 3 pages, 1 board and 5 other files will be moved to the trash.",
    );
    expect(folderDeleteBody({ pages: 1, boards: 0, otherFiles: 0 })).toBe("Its 1 page will be moved to the trash.");
    expect(folderDeleteBody({ pages: 0, boards: 2, otherFiles: 1 })).toBe(
      "Its 2 boards and 1 other file will be moved to the trash.",
    );
  });
});

describe("deleting a database that owns its rows (#7prbquxu phase 4a, @opus-hunter's note b)", () => {
  const folder = (id: string, otherFiles = 0): PageMeta => ({ ...meta(id, id), kind: "folder", otherFiles });
  const base: PageMeta = { ...meta("People.base", "People"), kind: "base", rowsFolder: "People" };

  it("asks when the rows folder holds rows or other files; only an empty one goes without asking", () => {
    expect(databaseDeleteAsk([base, folder("People")], base)).toBeNull();
    expect(databaseDeleteAsk([base, folder("People"), meta("People/Ann", "Ann", "People")], base)).toEqual({ rows: 1, otherFiles: 0 });
    // Attachments only: never moved to the Trash without asking.
    expect(databaseDeleteAsk([base, folder("People", 3)], base)).toEqual({ rows: 0, otherFiles: 3 });
  });
});
