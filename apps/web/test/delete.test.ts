import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import {
  deleteDialogBody,
  directSubPages,
  focusAfterDelete,
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
