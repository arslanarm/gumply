import { describe, expect, it } from "vitest";
import { pickerPlacement } from "../src/bases/SelectPicker";

/**
 * #7prbquxu (@polish-dev, @lead): where a Select cell's picker goes, measured against the **visual** viewport.
 * On iOS the keyboard shrinks the visual viewport, not the window, so a picker placed by `innerHeight` alone
 * opened under the keyboard.
 */

const cell = (top: number) => ({ top, bottom: top + 34, left: 300, width: 160 });

describe("the Select picker's placement", () => {
  it("with the whole window visible, it opens under its cell", () => {
    expect(pickerPlacement(cell(100), 200, { width: 1280, height: 800, offsetTop: 0 }, 800)).toEqual({ left: 300, width: 224, maxHeight: 658, top: 134 });
  });

  it("with an on-screen keyboard (the visual viewport 300 px of an 800 px window), it opens above, sized to the room there", () => {
    expect(pickerPlacement(cell(250), 200, { width: 1280, height: 300, offsetTop: 0 }, 800)).toEqual({ left: 300, width: 224, maxHeight: 242, bottom: 550 });
  });

  it("with the page scrolled inside a zoomed or shrunk visual viewport, it measures from that viewport's top", () => {
    // The visual viewport shows 400..700 of the layout; the cell sits at 420, near its top: below it is.
    expect(pickerPlacement(cell(420), 200, { width: 1280, height: 300, offsetTop: 400 }, 800)).toEqual({ left: 300, width: 224, maxHeight: 238, top: 454 });
  });

  it("with a pinch-zoomed page scrolled sideways, it stays inside the visible part (@opus-hunter)", () => {
    // The visual viewport shows x 500..900; a cell at x 300 is left of it: the picker starts at its left edge + 8.
    expect(pickerPlacement(cell(100), 200, { width: 400, height: 800, offsetTop: 0, offsetLeft: 500 }, 800)).toMatchObject({ left: 508, width: 224 });
  });
});
