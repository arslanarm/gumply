import { describe, expect, it } from "vitest";
import { boardLinkParts, idFromVaultPath, isBoard, isBoardId, vaultPathOf } from "../src/lib/boards.js";
import { canMovePage } from "../src/lib/tree.js";
import type { PageMeta } from "@gumply/core";

function meta(id: string, kind?: "page" | "whiteboard"): PageMeta {
  const slash = id.lastIndexOf("/");
  return {
    id,
    ...(kind ? { kind } : {}),
    title: id.slice(slash + 1).replace(/\.canvas$/, ""),
    tags: [],
    parentId: slash === -1 ? null : id.slice(0, slash),
    childCount: 0,
    created: "",
    updated: "",
  };
}

describe("board ids and paths", () => {
  it("tells boards from pages by id and kind", () => {
    expect(isBoardId("Projects/Map.canvas")).toBe(true);
    expect(isBoardId("Plan.canvas 2")).toBe(false);
    expect(isBoardId("Notes")).toBe(false);
    expect(isBoardId(null)).toBe(false);
    expect(isBoard(meta("Map.canvas"))).toBe(true);
    expect(isBoard({ id: "odd", kind: "whiteboard" })).toBe(true);
    expect(isBoard(meta("Notes", "page"))).toBe(false);
  });

  it("maps between ids and vault paths", () => {
    expect(vaultPathOf(meta("Projects/Q1 plan"))).toBe("Projects/Q1 plan.md");
    expect(vaultPathOf(meta("Projects/Map.canvas", "whiteboard"))).toBe("Projects/Map.canvas");
    expect(idFromVaultPath("Projects/Q1 plan.md")).toBe("Projects/Q1 plan");
    expect(idFromVaultPath("/Map.canvas")).toBe("Map.canvas");
    expect(idFromVaultPath("attachments/pic.png")).toBeNull();
  });

  it("links a board by file name with the title as alias", () => {
    expect(boardLinkParts({ id: "Projects/Map.canvas", title: "Map" })).toEqual({ target: "Map.canvas", alias: "Map" });
  });

  it("never moves anything under a board", () => {
    const pages = [meta("Notes"), meta("Map.canvas", "whiteboard"), meta("Other")];
    expect(canMovePage(pages, "Notes", "Map.canvas")).toBe(false);
    expect(canMovePage(pages, "Notes", "Other")).toBe(true);
    // A board itself can move under a page.
    expect(canMovePage(pages, "Map.canvas", "Other")).toBe(true);
  });
});
