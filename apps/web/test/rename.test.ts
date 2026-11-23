import { describe, expect, it } from "vitest";
import { openPageNeedsReload, plannedTitleRename, reloadDecision } from "../src/lib/rename.js";

describe("plannedTitleRename", () => {
  it("sends a title the user actually changed", () => {
    expect(plannedTitleRename("Target Renamed", "Target")).toBe("Target Renamed");
    expect(plannedTitleRename("  Target Renamed  ", "Target")).toBe("Target Renamed");
  });

  it("ignores a stale draft that still equals the title it started from", () => {
    // Regression #n8kk26sc: the sidebar renamed Target -> Target Renamed while
    // the header's auto-focused input still held the old draft. The header blur
    // must not send "Target" back and revert the rename + link rewrite.
    expect(plannedTitleRename("Target", "Target")).toBeNull();
  });

  it("ignores an empty title so the previous name is restored", () => {
    expect(plannedTitleRename("", "Target")).toBeNull();
    expect(plannedTitleRename("   ", "Target")).toBeNull();
  });
});

describe("openPageNeedsReload", () => {
  it("reloads when the open page had links rewritten", () => {
    expect(openPageNeedsReload(["source", "other"], "source", "target")).toBe(true);
  });

  it("does not reload unrelated open pages", () => {
    expect(openPageNeedsReload(["source"], "unrelated", "target")).toBe(false);
  });

  it("never reloads the page being renamed", () => {
    expect(openPageNeedsReload(["target"], "target", "target")).toBe(false);
  });

  it("does nothing when no page is open", () => {
    expect(openPageNeedsReload(["source"], null, "target")).toBe(false);
  });

  it("falls back to reloading when the server omits rewrittenPages", () => {
    expect(openPageNeedsReload(undefined, "source", "target")).toBe(true);
    expect(openPageNeedsReload(undefined, null, "target")).toBe(false);
  });
});

describe("reloadDecision (#iihi4dg7): a reload never drops unsaved text", () => {
  it("a clean page reloads, whatever asked for it", () => {
    for (const kind of ["auto", "replace", "refresh"] as const) expect(reloadDecision(kind, false), kind).toBe("reload");
  });

  it("a rename's or tag rename's rewrite leaves a page with unsaved text alone", () => {
    expect(reloadDecision("auto", true)).toBe("leave");
  });

  it("a restore, an Undo or a resolved copy keeps the unsaved text in History first", () => {
    expect(reloadDecision("replace", true)).toBe("keep-then-reload");
  });

  it("clicking the open page again saves the typing first", () => {
    expect(reloadDecision("refresh", true)).toBe("flush-then-reload");
  });
});
