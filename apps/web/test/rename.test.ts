import { describe, expect, it } from "vitest";
import { openPageAfterRename, openPageNeedsReload, plannedTitleRename } from "../src/lib/rename.js";

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

describe("openPageAfterRename: never drop unsaved text", () => {
  it("a rewritten open page with unsaved text is kept, not reloaded", () => {
    expect(openPageAfterRename(["Writer"], "Writer", "Hub renamed", true)).toBe("keep");
    expect(openPageAfterRename(undefined, "Writer", "Hub renamed", true)).toBe("keep");
  });

  it("a clean rewritten open page is reloaded, as before", () => {
    expect(openPageAfterRename(["Writer"], "Writer", "Hub renamed", false)).toBe("reload");
  });

  it("nothing to do when the open page wasn't rewritten, or is the renamed page", () => {
    expect(openPageAfterRename(["Other"], "Writer", "Hub renamed", true)).toBe("nothing");
    expect(openPageAfterRename(["Writer"], "Hub renamed", "Hub renamed", false)).toBe("nothing");
    expect(openPageAfterRename(["Writer"], null, "Hub renamed", false)).toBe("nothing");
  });
});
