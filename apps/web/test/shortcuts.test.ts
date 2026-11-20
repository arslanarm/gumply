import { describe, expect, it } from "vitest";
import { modifierLabel, shortcutGroups } from "../src/lib/shortcuts.js";

describe("shortcut platform label", () => {
  it("uses ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(modifierLabel("MacIntel")).toBe("⌘");
    expect(modifierLabel("macOS")).toBe("⌘");
    expect(modifierLabel("iPhone")).toBe("⌘");
    expect(modifierLabel("Win32")).toBe("Ctrl");
    expect(modifierLabel("Linux x86_64")).toBe("Ctrl");
    expect(modifierLabel("")).toBe("Ctrl");
  });

  it("puts the platform modifier into the listed shortcuts", () => {
    const mac = shortcutGroups("⌘");
    const other = shortcutGroups("Ctrl");
    expect(mac[0]?.items[0]?.keys).toBe("⌘K");
    expect(other[0]?.items[0]?.keys).toBe("CtrlK");
    expect(mac[0]?.items[1]?.keys).toBe("⌘\\");
    expect(other[0]?.items[1]?.keys).toBe("Ctrl\\");
    expect(mac[1]?.items.some((item) => item.keys === "⌘Z")).toBe(true);
    expect(mac[1]?.items.some((item) => item.keys === "⌘S")).toBe(true);
    expect(other[1]?.items.some((item) => item.keys === "CtrlZ")).toBe(true);
  });

  it("lists the documented groups and only working shortcuts", () => {
    const groups = shortcutGroups("Ctrl");
    expect(groups.map((group) => group.title)).toEqual(["Navigate", "Editor", "Pages"]);
    const editorKeys = groups[1]?.items.map((item) => item.keys) ?? [];
    for (const key of ["/", "[[", "#", "-", "1.", "- [ ]", ">", "```", "CtrlZ", "CtrlS"]) {
      expect(editorKeys).toContain(key);
    }
    expect(groups[2]?.items.map((item) => item.keys)).toContain("Enter");
    expect(groups[2]?.items.map((item) => item.keys)).toContain("F2 / double-click");
  });
});
