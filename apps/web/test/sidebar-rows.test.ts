import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { buildPageTree, shareTree, type PageTreeNode } from "../src/lib/tree.js";
import { createRowStateStore } from "../src/components/sidebar-row-state.js";

/** #8gudbajp: the sidebar re-renders only the rows whose data changed. */
const meta = (id: string, parentId: string | null = null, title = id): PageMeta =>
  ({ id, title, parentId, updated: "2026-11-25T00:00:00.000Z", created: "2026-11-25T00:00:00.000Z" }) as unknown as PageMeta;

const build = (pages: PageMeta[], previous: ReadonlyMap<string, PageTreeNode>) => shareTree(buildPageTree(pages), previous);

describe("shareTree keeps unchanged nodes", () => {
  const pages = [meta("Folder"), meta("Folder/a", "Folder"), meta("Folder/b", "Folder"), meta("Other")];

  it("a rebuild from an equal list (new objects) returns the very same nodes", () => {
    const first = build(pages, new Map());
    const second = build(pages.map((page) => ({ ...page })), first.nodes);
    expect(second.roots[0]).toBe(first.roots[0]);
    expect(second.roots[1]).toBe(first.roots[1]);
  });

  it("a changed page is new, and so are its ancestors; its siblings and other branches are kept", () => {
    const first = build(pages, new Map());
    const changed = pages.map((page) => (page.id === "Folder/b" ? { ...page, title: "B renamed" } : { ...page }));
    const second = build(changed, first.nodes);
    const folderBefore = first.roots.find((node) => node.page.id === "Folder")!;
    const folderAfter = second.roots.find((node) => node.page.id === "Folder")!;
    expect(folderAfter).not.toBe(folderBefore);
    expect(folderAfter.children.find((node) => node.page.id === "Folder/a")).toBe(folderBefore.children.find((node) => node.page.id === "Folder/a"));
    expect(folderAfter.children.find((node) => node.page.id === "Folder/b")).not.toBe(folderBefore.children.find((node) => node.page.id === "Folder/b"));
    expect(second.roots.find((node) => node.page.id === "Other")).toBe(first.roots.find((node) => node.page.id === "Other"));
  });

  it("a new page renews only its parent's branch", () => {
    const first = build(pages, new Map());
    const second = build([...pages.map((page) => ({ ...page })), meta("Folder/c", "Folder")], first.nodes);
    expect(second.roots.find((node) => node.page.id === "Other")).toBe(first.roots.find((node) => node.page.id === "Other"));
    expect(second.roots.find((node) => node.page.id === "Folder")!.children).toHaveLength(3);
  });
});

describe("the row state store", () => {
  it("notifies on a change and not on the same state", () => {
    const store = createRowStateStore({ selectedId: "a", renamingId: null, renameDraft: "" });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.set({ selectedId: "a", renamingId: null, renameDraft: "" });
    expect(calls).toBe(0);
    store.set({ selectedId: "b", renamingId: null, renameDraft: "" });
    expect(calls).toBe(1);
    expect(store.get().selectedId).toBe("b");
  });
});
