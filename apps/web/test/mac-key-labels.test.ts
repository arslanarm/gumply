import { afterEach, describe, expect, it, vi } from "vitest";
import { markActions } from "../src/editor/formatting.js";

/**
 * #x8uddj3z: the formatting labels (the selection toolbar and the editor's right-click menu) write a
 * modifier and one key as each platform does: "⌘B" on a Mac, "Ctrl+B" elsewhere, as the `?` sheet
 * does since #t5n77tdv. Combinations with Shift keep the "+" form ("⌘+Shift+S"), like the sheet.
 */
afterEach(() => vi.unstubAllGlobals());

const keys = () => Object.fromEntries(markActions().map((action) => [action.mark, action.keys]));

describe("formatting key labels per platform (#x8uddj3z)", () => {
  it("on a Mac: ⌘B, ⌘I, ⌘E, with no plus after ⌘ for a single key", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(keys()).toMatchObject({ bold: "⌘B", italic: "⌘I", code: "⌘E", strike: "⌘+Shift+S" });
  });

  it("on Windows and Linux: Ctrl+B, Ctrl+I, Ctrl+E", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(keys()).toMatchObject({ bold: "Ctrl+B", italic: "Ctrl+I", code: "Ctrl+E", strike: "Ctrl+Shift+S" });
  });
});
