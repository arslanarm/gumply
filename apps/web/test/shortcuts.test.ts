import { describe, expect, it } from "vitest";
import { modifierLabel, shortcutGroups, withModifier } from "../src/lib/shortcuts.js";

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
    expect(other[0]?.items[0]?.keys).toBe("Ctrl+K");
    expect(mac[0]?.items[1]?.keys).toBe("⌘\\");
    expect(other[0]?.items[1]?.keys).toBe("Ctrl+\\");
    expect(mac[1]?.items.some((item) => item.keys === "⌘Z")).toBe(true);
    expect(mac[1]?.items.some((item) => item.keys === "⌘S")).toBe(true);
    expect(other[1]?.items.some((item) => item.keys === "Ctrl+Z")).toBe(true);
  });

  it("lists the documented groups and only working shortcuts", () => {
    const groups = shortcutGroups("Ctrl");
    expect(groups.map((group) => group.title)).toEqual(["Navigate", "Editor", "Pages", "Databases", "Whiteboard"]);
    const editorKeys = groups[1]?.items.map((item) => item.keys) ?? [];
    for (const key of ["/", "[[", "#", "-", "1.", "- [ ]", ">", "```", "Ctrl+Z", "Ctrl+S", "Shift+← / →"]) {
      expect(editorKeys).toContain(key);
    }
    expect(groups[2]?.items.map((item) => item.keys)).toContain("Enter");
    expect(groups[2]?.items.map((item) => item.keys)).toContain("F2 / double-click");
  });

  it("lists the whiteboard shortcuts with the platform modifier", () => {
    const board = shortcutGroups("⌘").find((group) => group.title === "Whiteboard");
    const keys = board?.items.map((item) => item.keys) ?? [];
    for (const key of ["V / H", "N / T / S", "C / F / P", "Shift+1", "⌘D", "⌘Z / ⌘+Shift+Z", "] / ["]) {
      expect(keys).toContain(key);
    }
  });

  it("writes Ctrl with a plus, as Windows and Linux do: Ctrl+D, not CtrlD (#t5n77tdv)", () => {
    const keys = shortcutGroups("Ctrl").flatMap((group) => group.items.map((item) => item.keys));
    for (const key of ["Ctrl+K", "Ctrl+D", "Ctrl+C / Ctrl+V", "Ctrl+Z / Ctrl+Shift+Z", "Ctrl+Shift+D"]) expect(keys).toContain(key);
    expect(keys.filter((key) => /Ctrl[A-Z\\]/.test(key))).toEqual([]);
    expect(withModifier("⌘", "K")).toBe("⌘K");
    expect(withModifier("Ctrl", "K")).toBe("Ctrl+K");
  });
});
