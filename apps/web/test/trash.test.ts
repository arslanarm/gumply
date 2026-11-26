import type { RestoreResult, TrashItem } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { pageIdFromHash, trashHash, trashRouteFromHash } from "../src/lib/routing";
import {
  deleteForeverBody,
  emptyTrashBody,
  filterTrash,
  restoredId,
  restoredMessage,
  trashDepth,
  trashedCount,
  trashLocation,
} from "../src/lib/trash";

function item(overrides: Partial<TrashItem> = {}): TrashItem {
  return {
    trashId: "t1",
    id: "Projects/Plan",
    kind: "page",
    title: "Plan",
    parentId: null,
    deletedAt: "2026-11-21T10:00:00.000Z",
    originalParentId: "Projects",
    originalParentTitle: "Projects",
    children: [
      { id: "Projects/Plan/Week 1", kind: "page", title: "Week 1", parentId: "Projects/Plan" },
      { id: "Projects/Plan/Week 1/Notes", kind: "page", title: "Notes", parentId: "Projects/Plan/Week 1" },
    ],
    ...overrides,
  };
}

const result = (overrides: Partial<RestoreResult> = {}): RestoreResult => ({
  restored: [],
  id: "Projects/Plan",
  movedToTopLevel: false,
  renamed: false,
  ...overrides,
});

describe("trash routes (#ppag3ugh)", () => {
  it("round-trips the list, an entry and a sub-page", () => {
    expect(trashHash()).toBe("#trash");
    expect(trashRouteFromHash("#trash")).toEqual({ trashId: null, id: null });
    expect(trashRouteFromHash(trashHash("ab-12"))).toEqual({ trashId: "ab-12", id: null });
    const hash = trashHash("ab-12", "Projects/Plan/Week 1");
    expect(hash).toBe("#trash/ab-12/Projects/Plan/Week%201");
    expect(trashRouteFromHash(hash)).toEqual({ trashId: "ab-12", id: "Projects/Plan/Week 1" });
  });

  it("never collides with pages and rejects odd ids", () => {
    // A page called "trash" is `#/trash`.
    expect(trashRouteFromHash("#/trash")).toBeNull();
    expect(pageIdFromHash("#trash")).toBeNull();
    for (const bad of ["#trash/", "#trash/a.b", "#trash/..", "#trashy", "#trash/ok/..%2Fx"]) {
      expect(trashRouteFromHash(bad), bad).toBeNull();
    }
  });
});

describe("trash helpers", () => {
  it("filters by the entry's or a sub-page's title, accent- and case-insensitive", () => {
    const items = [item(), item({ trashId: "t2", id: "Café", title: "Café", children: [] })];
    expect(filterTrash(items, "").length).toBe(2);
    expect(filterTrash(items, "cafe").map((entry) => entry.trashId)).toEqual(["t2"]);
    expect(filterTrash(items, "NOTES").map((entry) => entry.trashId)).toEqual(["t1"]);
    expect(filterTrash(items, "nothing")).toEqual([]);
  });

  it("counts pages and boards including sub-pages", () => {
    expect(trashedCount([item(), item({ children: [] })])).toBe(4);
    expect(trashedCount([])).toBe(0);
  });

  it("names where it was", () => {
    expect(trashLocation(item())).toBe("Projects");
    expect(trashLocation(item({ originalParentId: null, originalParentTitle: null }))).toBe("");
    expect(trashLocation(item({ originalParentId: "Old/Folder", originalParentTitle: null }))).toBe("Folder");
  });

  it("confirmation texts say what goes and that it can't be undone", () => {
    expect(deleteForeverBody(item())).toBe(
      "This deletes this page and 2 sub-pages from your vault for good. You can't undo this. This also deletes its version history.",
    );
    expect(deleteForeverBody(item({ kind: "whiteboard", children: [] }))).toBe(
      "This deletes this whiteboard from your vault for good. You can't undo this. This also deletes its version history.",
    );
    expect(emptyTrashBody([item({ children: [] })])).toBe(
      "This deletes 1 page or whiteboard from your vault for good. You can't undo this. This also deletes its version history.",
    );
    expect(emptyTrashBody([item()])).toContain("3 pages and whiteboards");
    expect(deleteForeverBody(item({ kind: "folder", otherFiles: 5 }))).toBe(
      "This deletes this folder with its 2 pages and whiteboards and 5 other files from your vault for good. You can't undo this. This also deletes its version history.",
    );
  });

  it("a database deleted with its rows says how many rows go with it (#7prbquxu phase 4a, note c)", () => {
    const database = item({ id: "People.base", kind: "base", title: "People", children: [], rows: 12, otherFiles: 1 });
    expect(trashedCount([database])).toBe(13);
    expect(deleteForeverBody(database)).toBe(
      "This deletes this database with its 12 rows and 1 other file from your vault for good. You can't undo this. This also deletes its version history.",
    );
  });

  it("explains a restore that went somewhere else", () => {
    expect(restoredMessage(item(), result())).toBe("Restored “Plan”.");
    expect(restoredMessage(item({ originalParentTitle: null }), result({ id: "Plan", movedToTopLevel: true }))).toBe(
      "Restored “Plan” to the top level: “Projects” is no longer there.",
    );
    expect(restoredMessage(item(), result({ id: "Projects/Plan 2", renamed: true }))).toBe(
      "Restored “Plan” as “Plan 2”: that name was taken.",
    );
    expect(
      restoredMessage(item({ originalParentTitle: null }), result({ id: "Plan 2", movedToTopLevel: true, renamed: true })),
    ).toBe("Restored “Plan” to the top level as “Plan 2”: “Projects” is no longer there and that name was taken.");
    expect(
      restoredMessage(item({ kind: "whiteboard", id: "Map.canvas", title: "Map" }), result({ id: "Map 2.canvas", renamed: true })),
    ).toBe("Restored “Map” as “Map 2”: that name was taken.");
  });

  it("maps a sub-page to where it is after the restore, and knows its depth", () => {
    const moved = result({ id: "Plan 2" });
    expect(restoredId(item(), moved, "Projects/Plan")).toBe("Plan 2");
    expect(restoredId(item(), moved, "Projects/Plan/Week 1/Notes")).toBe("Plan 2/Week 1/Notes");
    expect(trashDepth(item(), "Projects/Plan/Week 1")).toBe(1);
    expect(trashDepth(item(), "Projects/Plan/Week 1/Notes")).toBe(2);
  });
});
