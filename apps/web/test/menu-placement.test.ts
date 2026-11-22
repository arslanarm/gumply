import { describe, expect, it } from "vitest";
import { MENU_MARGIN, placeMenu } from "../src/lib/menu-placement.js";

/** #sjts42ue: the sidebar ⋯ menu's placement (below, flipped up, scrolling, at the pointer). */

const viewport = { width: 1280, height: 820 };
const size = { width: 240, height: 400 };
const button = (top: number, right = 260) => ({ left: right - 24, top, right, bottom: top + 24 });

describe("placeMenu below a button", () => {
  it("opens under the button, right-aligned to it", () => {
    expect(placeMenu({ button: button(100) }, size, viewport)).toEqual({ left: 20, top: 128, above: false });
  });

  it("flips above when there's no room below (a row near the footer)", () => {
    const placed = placeMenu({ button: button(700) }, size, viewport);
    expect(placed).toEqual({ left: 20, top: 700 - 4 - 400, above: true });
  });

  it("room neither way: moved to fit inside the viewport, last item on screen", () => {
    const small = { width: 1280, height: 600 };
    const placed = placeMenu({ button: button(250) }, { width: 240, height: 500 }, small);
    expect(placed.maxHeight).toBeUndefined();
    expect(placed.top + 500).toBeLessThanOrEqual(small.height - MENU_MARGIN);
    expect(placed.top).toBeGreaterThanOrEqual(MENU_MARGIN);
  });

  it("taller than the viewport: pinned to the top and scrolls", () => {
    const placed = placeMenu({ button: button(300) }, { width: 240, height: 900 }, { width: 1280, height: 600 });
    expect(placed).toEqual({ left: 20, top: MENU_MARGIN, maxHeight: 600 - 2 * MENU_MARGIN, above: false });
  });

  it("never runs off the left edge", () => {
    expect(placeMenu({ button: button(100, 120) }, size, viewport).left).toBe(MENU_MARGIN);
  });
});

describe("placeMenu at a point (right-click)", () => {
  it("top-left corner at the pointer", () => {
    expect(placeMenu({ point: { x: 60, y: 200 } }, size, viewport)).toEqual({ left: 60, top: 200, above: false });
  });

  it("flips up near the bottom and left near the right edge", () => {
    const placed = placeMenu({ point: { x: 1200, y: 700 } }, size, viewport);
    expect(placed).toEqual({ left: 1200 - 240, top: 300, above: true });
  });

  it("stays inside on a short window", () => {
    const placed = placeMenu({ point: { x: 60, y: 300 } }, { width: 240, height: 500 }, { width: 1280, height: 600 });
    expect(placed.top).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(placed.top + 500).toBeLessThanOrEqual(600 - MENU_MARGIN);
  });
});
