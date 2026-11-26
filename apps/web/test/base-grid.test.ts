import { describe, expect, it } from "vitest";
import { copiedText, gridMoveFor, moveCell, typedValue, typingStarts } from "../src/bases/grid";

describe("the database grid's keyboard (#7prbquxu, spec/database-tables §4)", () => {
  it("arrows move one cell and stop at the edges; Down past the last row reaches the typing row", () => {
    const at = { row: 1, col: 1 };
    expect(moveCell(at, "up", 3, 3)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 0, col: 1 }, "up", 3, 3)).toEqual({ row: 0, col: 1 });
    expect(moveCell(at, "left", 3, 3)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 0 }, "left", 3, 3)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 2 }, "right", 3, 3)).toEqual({ row: 1, col: 2 });
    expect(moveCell(at, "down", 3, 3)).toEqual({ row: 2, col: 1 });
    expect(moveCell({ row: 2, col: 1 }, "down", 3, 3)).toBe("past-end");
  });

  it("Tab and Shift+Tab wrap across rows; Tab past the last cell reaches the typing row", () => {
    expect(moveCell({ row: 0, col: 2 }, "next", 2, 3)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 2 }, "next", 2, 3)).toBe("past-end");
    expect(moveCell({ row: 1, col: 0 }, "prev", 2, 3)).toEqual({ row: 0, col: 2 });
    expect(moveCell({ row: 0, col: 0 }, "prev", 2, 3)).toEqual({ row: 0, col: 0 });
    expect(gridMoveFor("Tab", false)).toBe("next");
    expect(gridMoveFor("Tab", true)).toBe("prev");
    expect(gridMoveFor("ArrowDown", false)).toBe("down");
    expect(gridMoveFor("a", false)).toBeNull();
  });

  it("typing starts an edit in text-like cells, opens the picker in date cells, and does nothing elsewhere", () => {
    expect(typingStarts("text", true)).toBe("type");
    expect(typingStarts("number", true)).toBe("type");
    expect(typingStarts("multitext", true)).toBe("type");
    expect(typingStarts("date", true)).toBe("editor");
    expect(typingStarts("datetime", true)).toBe("editor");
    expect(typingStarts("checkbox", true)).toBe("none");
    expect(typingStarts("text", false)).toBe("none");
  });

  it("typed text becomes the column's type; text that isn't one is refused", () => {
    expect(typedValue("  Ada  ", "text")).toEqual({ value: "Ada" });
    expect(typedValue("", "text")).toEqual({ value: null });
    expect(typedValue("3.5", "number")).toEqual({ value: 3.5 });
    expect(typedValue("abc", "number")).toBeNull();
    expect(typedValue("Rust, Go, Rust,", "multitext")).toEqual({ value: ["Rust", "Go"] });
    expect(typedValue("#work, home", "tags")).toEqual({ value: ["work", "home"] });
    expect(typedValue("Привет", "text")).toEqual({ value: "Привет" });
  });

  it("copies a cell as spreadsheet text", () => {
    expect(copiedText("Ada", "text")).toBe("Ada");
    expect(copiedText(["Rust", "Go"], "multitext")).toBe("Rust, Go");
    expect(copiedText(true, "checkbox")).toBe("TRUE");
    expect(copiedText(false, "checkbox")).toBe("FALSE");
    expect(copiedText(null, "text")).toBe("");
    expect(copiedText(3, "number")).toBe("3");
  });
});
