import { afterEach, describe, expect, it } from "vitest";
import type { PageMeta } from "@gumply/core";
import { commandApplies, menuLabel, ROW_MENU } from "../src/lib/commands.js";
import { isDesktopApp, pageWindowUrl, setDesktopApp, wantsNewWindow } from "../src/lib/desktop-app.js";

/** #vhdp68sm (N8): "Open in new window" exists only in the desktop app, and opens the page's own address. */
const page = (id: string, kind: PageMeta["kind"] = "page"): PageMeta => ({ id, kind, title: id, tags: [], parentId: null, childCount: 0, created: "", updated: "" });
const context = (p: PageMeta | null) => ({ page: p, editor: false, board: false, desktop: false });

afterEach(() => setDesktopApp(false));

describe("Open in new window (N8)", () => {
  it("only in the desktop app, for pages, boards and views, never folders", () => {
    expect(isDesktopApp()).toBe(false);
    expect(commandApplies("page.open-window", context(page("Notes")))).toBe(false);
    setDesktopApp(true);
    expect(commandApplies("page.open-window", context(page("Notes")))).toBe(true);
    expect(commandApplies("page.open-window", context(page("Plan.canvas", "whiteboard")))).toBe(true);
    expect(commandApplies("page.open-window", context(page("Tasks.base", "base")))).toBe(true);
    expect(commandApplies("page.open-window", context(page("Folder", "folder")))).toBe(false);
    expect(commandApplies("page.open-window", context(null))).toBe(false);
  });

  it("sits in the ⋯ menu's first group, after Move to, with its own label", () => {
    expect(ROW_MENU[0]).toEqual(["page.rename", "page.duplicate", "page.copy-link", "page.move", "page.open-window"]);
    expect(menuLabel("page.open-window", page("Notes"))).toBe("Open in new window");
  });

  it("opens the app's own address for the page (ids encoded), which the desktop app turns into a window", () => {
    expect(pageWindowUrl("Projects/Road map", { origin: "http://127.0.0.1:4100", pathname: "/" })).toBe("http://127.0.0.1:4100/#/Projects%2FRoad%20map");
  });

  it("Cmd/Ctrl+click asks for a new window only in the desktop app", () => {
    expect(wantsNewWindow({ metaKey: false, ctrlKey: true })).toBe(false);
    setDesktopApp(true);
    expect(wantsNewWindow({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(wantsNewWindow({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(wantsNewWindow({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
