import type { PageMeta } from "@gumply/core";
import { describe, expect, it } from "vitest";
import { moveTargets, moveToastMessage } from "../src/lib/move.js";

function page(id: string, title: string, parentId: string | null = null): PageMeta {
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
  page("projects", "Projects"),
  page("projects/plan", "Plan", "projects"),
  page("projects/plan/q3", "Q3", "projects/plan"),
  page("archive", "Archive"),
  page("archive/plan", "Plan", "archive"),
  page("inbox", "Inbox"),
];

describe("moveTargets", () => {
  it("offers Top level first for a nested page", () => {
    const rows = moveTargets(pages, "projects/plan", "");
    expect(rows[0]).toMatchObject({ kind: "top", label: "Top level", parentId: null });
  });

  it("omits Top level when the page is already at the top", () => {
    const rows = moveTargets(pages, "inbox", "");
    expect(rows.some((row) => row.kind === "top")).toBe(false);
  });

  it("excludes the page itself, its descendants and its current parent", () => {
    const ids = moveTargets(pages, "projects/plan", "").map((row) => row.key);
    expect(ids).not.toContain("projects/plan");
    expect(ids).not.toContain("projects/plan/q3");
    expect(ids).not.toContain("projects");
    expect(ids).toContain("inbox");
  });

  it("filters by title, case-insensitively", () => {
    const rows = moveTargets(pages, "projects/plan", "arch");
    expect(rows.map((row) => row.label)).toEqual(["Top level", "Archive"]);
  });

  it("sorts page targets by title", () => {
    const rows = moveTargets(pages, "archive/plan", "")
      .filter((row) => row.kind === "page")
      .map((row) => row.label);
    expect(rows).toEqual(["Inbox", "Plan", "Projects", "Q3"]);
  });

  it("shows the folder for duplicate target titles", () => {
    const rows = moveTargets(pages, "inbox", "plan");
    expect(rows.map((row) => [row.label, row.path])).toEqual([
      ["Plan", "Archive"],
      ["Plan", "Projects"],
    ]);
  });

  it("returns nothing for a page that no longer exists", () => {
    expect(moveTargets(pages, "gone", "")).toEqual([]);
  });
});

describe("moveToastMessage", () => {
  it("names the new parent", () => {
    expect(moveToastMessage(pages, "archive")).toBe("Moved to “Archive”");
  });

  it("uses plain copy for the top level", () => {
    expect(moveToastMessage(pages, null)).toBe("Moved to top level");
  });

  it("falls back when the parent is unknown", () => {
    expect(moveToastMessage(pages, "gone")).toBe("Page moved");
  });
});
