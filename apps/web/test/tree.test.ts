import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildPageTree, canMovePage, isSelfOrDescendant } from "../src/lib/tree.js";

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
