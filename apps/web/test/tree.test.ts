import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildPageTree, canMovePage, isSelfOrDescendant, pageTrail } from "../src/lib/tree.js";

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

function shape(nodes: ReturnType<typeof buildPageTree>): unknown[] {
  return nodes.map((node) => ({
    id: node.page.id,
    children: shape(node.children),
  }));
}

describe("buildPageTree", () => {
  it("nests children by parentId and sorts siblings by title", () => {
    const tree = buildPageTree([
      meta("projects/gumply", "Gumply", "projects"),
      meta("projects", "Projects"),
      meta("about", "About"),
      meta("inbox", "inbox"),
    ]);

    expect(shape(tree)).toEqual([
      { id: "about", children: [] },
      { id: "inbox", children: [] },
      { id: "projects", children: [{ id: "projects/gumply", children: [] }] },
    ]);
  });

  it("sorts numeric titles naturally", () => {
    const tree = buildPageTree([
      meta("b10", "Bulk 10"),
      meta("b2", "Bulk 2"),
      meta("b1", "Bulk 1"),
    ]);
    expect(tree.map((node) => node.page.title)).toEqual(["Bulk 1", "Bulk 2", "Bulk 10"]);
  });

  it("promotes pages with a missing parent to roots", () => {
    const tree = buildPageTree([meta("orphan", "Orphan", "gone")]);
    expect(shape(tree)).toEqual([{ id: "orphan", children: [] }]);
  });

  it("does not loop on parent cycles", () => {
    const tree = buildPageTree([meta("a", "A", "b"), meta("b", "B", "a")]);
    expect(shape(tree)).toEqual([
      { id: "a", children: [] },
      { id: "b", children: [] },
    ]);
  });

  it("treats a self-parent as a root", () => {
    const tree = buildPageTree([meta("self", "Self", "self")]);
    expect(shape(tree)).toEqual([{ id: "self", children: [] }]);
  });
});

describe("isSelfOrDescendant", () => {
  it("matches the page itself and its descendants only", () => {
    expect(isSelfOrDescendant("a", "a")).toBe(true);
    expect(isSelfOrDescendant("a", "a/b")).toBe(true);
    expect(isSelfOrDescendant("a", "a/b/c")).toBe(true);
    expect(isSelfOrDescendant("a", "ab")).toBe(false);
    expect(isSelfOrDescendant("a/b", "a")).toBe(false);
  });
});

describe("canMovePage", () => {
  const pages = [
    meta("a", "A"),
    meta("a/b", "B", "a"),
    meta("c", "C"),
    meta("a/b/d", "D", "a/b"),
  ];

  it("allows moves to roots and unrelated pages", () => {
    expect(canMovePage(pages, "c", null)).toBe(true);
    expect(canMovePage(pages, "c", "a")).toBe(true);
    expect(canMovePage(pages, "a", null)).toBe(true);
  });

  it("rejects moving into itself or a descendant", () => {
    expect(canMovePage(pages, "a", "a")).toBe(false);
    expect(canMovePage(pages, "a", "a/b")).toBe(false);
    expect(canMovePage(pages, "a", "a/b/d")).toBe(false);
  });

  it("rejects unknown pages", () => {
    expect(canMovePage(pages, "missing", null)).toBe(false);
    expect(canMovePage(pages, "a", "missing")).toBe(false);
  });

  it("uses parent links even when ids do not nest by path", () => {
    const irregular = [meta("a", "A"), meta("b", "B", "a")];
    expect(canMovePage(irregular, "a", "b")).toBe(false);
  });
});

describe("pageTrail", () => {
  it("returns the root-to-page chain for a nested page", () => {
    const pages = [
      meta("projects", "Projects"),
      meta("projects/gumply", "Gumply", "projects"),
      meta("projects/gumply/q1", "Q1", "projects/gumply"),
    ];
    expect(pageTrail(pages, "projects/gumply/q1").map((page) => page.title)).toEqual([
      "Projects",
      "Gumply",
      "Q1",
    ]);
  });

  it("returns a single crumb for a root page and nothing for unknown ids", () => {
    expect(pageTrail([meta("welcome", "Welcome")], "welcome").map((page) => page.id)).toEqual([
      "welcome",
    ]);
    expect(pageTrail([meta("welcome", "Welcome")], "missing")).toEqual([]);
  });
});

describe("plain folders (D33)", () => {
  const folder = (id: string, title: string, parentId: string | null = null): PageMeta => ({
    ...meta(id, title, parentId),
    kind: "folder",
  });

  it("lists folders before pages at every level, like Obsidian", () => {
    const pages = [
      meta("Alpha", "Alpha"),
      folder("Work", "Work"),
      meta("Work/Ideas", "Ideas", "Work"),
      folder("Work/Archive", "Archive", "Work"),
      folder("Home", "Home"),
    ];
    expect(shape(buildPageTree(pages))).toEqual([
      { id: "Home", children: [] },
      { id: "Work", children: [{ id: "Work/Archive", children: [] }, { id: "Work/Ideas", children: [] }] },
      { id: "Alpha", children: [] },
    ]);
  });

  it("folders take pages and other folders, never themselves or their own children", () => {
    const pages = [folder("Work", "Work"), folder("Work/Old", "Old", "Work"), meta("Note", "Note")];
    expect(canMovePage(pages, "Note", "Work")).toBe(true);
    expect(canMovePage(pages, "Work", "Note")).toBe(true);
    expect(canMovePage(pages, "Work", "Work/Old")).toBe(false);
    expect(canMovePage(pages, "Work/Old", null)).toBe(true);
  });
});

describe("a database's own rows folder (#7prbquxu phase 4, spec/database-tables §3)", () => {
  const pages = (showRows: boolean): PageMeta[] => [
    { ...meta("People.base", "People"), kind: "base", rowsFolder: "People", ...(showRows ? { showRows: true } : {}) },
    { ...meta("People", "People"), kind: "folder", ownedBy: "People.base" },
    meta("People/Ann", "Ann", "People"),
    { ...meta("People/Notes", "Notes", "People"), kind: "folder" },
    meta("People/Notes/Deep", "Deep", "People/Notes"),
    { ...meta("Projects", "Projects"), kind: "folder" },
  ];

  it("hides the folder and everything in it while the database doesn't ask to show its rows", () => {
    expect(shape(buildPageTree(pages(false)))).toEqual(shape(buildPageTree([pages(false)[0]!, pages(false)[5]!])));
  });

  it("shows them when the database asks to (the marker's showRows)", () => {
    const ids = (nodes: ReturnType<typeof buildPageTree>): string[] => nodes.flatMap((node) => [node.page.id, ...ids(node.children)]);
    expect(ids(buildPageTree(pages(true))).sort()).toEqual(["People", "People.base", "People/Ann", "People/Notes", "People/Notes/Deep", "Projects"]);
  });

  it("a folder no database owns any more shows as any folder", () => {
    const loose = pages(false).map((page) => {
      const { rowsFolder, ownedBy, ...rest } = page;
      void rowsFolder;
      void ownedBy;
      return rest;
    });
    expect(buildPageTree(loose).some((node) => node.page.id === "People")).toBe(true);
  });
});
