import { describe, expect, it } from "vitest";
import { cycleTarget, returnTarget } from "../src/lib/modal";

describe("cycleTarget (#vefk9dwg): Tab wraps inside a modal", () => {
  it("wraps from the last control to the first, and back with Shift+Tab", () => {
    expect(cycleTarget(3, 2, false)).toBe(0);
    expect(cycleTarget(3, 0, true)).toBe(2);
  });

  it("leaves Tab to the browser in the middle of the dialog", () => {
    expect(cycleTarget(3, 0, false)).toBe(-1);
    expect(cycleTarget(3, 1, false)).toBe(-1);
    expect(cycleTarget(3, 1, true)).toBe(-1);
  });

  it("brings focus that is outside the dialog back in, at the matching end", () => {
    expect(cycleTarget(4, -1, false)).toBe(0);
    expect(cycleTarget(4, -1, true)).toBe(3);
  });

  it("a dialog with one control keeps it; with none there is no target", () => {
    expect(cycleTarget(1, 0, false)).toBe(0);
    expect(cycleTarget(1, 0, true)).toBe(0);
    expect(cycleTarget(0, -1, false)).toBe(-1);
  });
});

describe("returnTarget (#vefk9dwg): where focus goes when a dialog closes", () => {
  const el = (name: string, isConnected = true) => ({ name, isConnected });
  const none = () => false;

  it("the opener, while it is still on the page", () => {
    const opener = el("export button");
    expect(returnTarget(opener, [el("older")], none)).toBe(opener);
  });

  it("a menu item that opened it is gone: the newest focused element still on the page", () => {
    const menuButton = el("page ⋯ button");
    const menuItem = el("History…", false);
    expect(returnTarget(menuItem, [el("editor"), menuButton, menuItem], none)).toBe(menuButton);
  });

  it("no opener (focus was on the page body): the focus history", () => {
    const settings = el("Settings button");
    expect(returnTarget(null, [settings, el("Settings → AI apps", false)], none)).toBe(settings);
  });

  it("never something inside the dialog itself, or excluded", () => {
    const inside = el("dialog's own button");
    const before = el("editor");
    expect(returnTarget(inside, [before, inside], (item) => item === inside)).toBe(before);
  });

  it("nothing left to return to", () => {
    expect(returnTarget(el("gone", false), [el("also gone", false)], none)).toBeNull();
  });
});
