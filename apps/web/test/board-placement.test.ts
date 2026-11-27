import { describe, expect, it } from "vitest";
import { freeSpot, nearestFree } from "../src/board/placement";

/**
 * #b9425ktw (#fzrwse3y's P3 5): a new page card goes where nothing is, near where it was asked for, instead of on
 * top of what's there (it covered Tomatoes and Pond and took their clicks).
 */

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("freeSpot", () => {
  const card = { width: 300, height: 160 };

  it("keeps the asked-for spot when it's free", () => {
    expect(freeSpot({ x: 0, y: 0, ...card }, [{ x: 600, y: 600, width: 200, height: 200 }])).toEqual({ x: 0, y: 0 });
  });

  it("moves off items it would cover, and covers none of them, with a gap", () => {
    const items = [
      { x: -50, y: -40, width: 200, height: 200 },
      { x: 180, y: 60, width: 200, height: 120 },
    ];
    const at = freeSpot({ x: 0, y: 0, ...card }, items);
    const placed = { ...at, ...card };
    for (const item of items) expect(overlaps(placed, { x: item.x - 16, y: item.y - 16, width: item.width + 32, height: item.height + 32 })).toBe(false);
  });

  it("stays near the asked-for spot: the nearest free ring wins", () => {
    const items = [{ x: 0, y: 0, width: 300, height: 160 }];
    const at = freeSpot({ x: 0, y: 0, ...card }, items);
    // One card's height (plus the gap) away at most, not across the board.
    expect(Math.hypot(at.x, at.y)).toBeLessThanOrEqual(card.width + 40);
  });

  it("frames don't count (a card may go inside one)", () => {
    expect(freeSpot({ x: 0, y: 0, ...card }, [{ x: -200, y: -200, width: 900, height: 700, type: "group" }])).toEqual({ x: 0, y: 0 });
  });

  it("a board crowded everywhere near: an offset spot, never the exact place of the item it covered", () => {
    const items = Array.from({ length: 41 * 41 }, (_, i) => ({ x: (i % 41) * 100 - 2000, y: Math.floor(i / 41) * 100 - 2000, width: 100, height: 100 }));
    const at = freeSpot({ x: 0, y: 0, ...card }, items);
    expect(at).not.toEqual({ x: 0, y: 0 });
  });

  it("with the visible part of the board given, only spots wholly inside it count (@opus-editor)", () => {
    // The centre is taken; the nearest free spot (just above) is out of view, the one just below is in it.
    const view = { x: -400, y: -100, width: 1200, height: 500 };
    const items = [{ x: -40, y: -40, width: 400, height: 260 }];
    const at = freeSpot({ x: 0, y: 0, ...card }, items, view);
    expect(at.x).toBeGreaterThanOrEqual(view.x);
    expect(at.y).toBeGreaterThanOrEqual(view.y);
    expect(at.x + card.width).toBeLessThanOrEqual(view.x + view.width);
    expect(at.y + card.height).toBeLessThanOrEqual(view.y + view.height);
  });

  it("the nearest free spot by straight-line distance, not the first ring's far corner", () => {
    // Blocks around (0,0) leave free: a spot 3 steps straight down, and nothing nearer.
    const items = [{ x: -400, y: -400, width: 1100, height: 520 }];
    const at = freeSpot({ x: 0, y: 0, width: 100, height: 60 }, items);
    expect(Math.hypot(at.x, at.y)).toBeLessThanOrEqual(160);
  });

  it("nearestFree says when nothing is free (in view): the caller then looks wider and moves the view, rather than covering an item", () => {
    const view = { x: -150, y: -100, width: 400, height: 300 };
    const items = [{ x: -100, y: -100, width: 200, height: 200 }];
    expect(nearestFree({ x: 0, y: 0, ...card }, items, view)).toBeNull();
    const wider = nearestFree({ x: 0, y: 0, ...card }, items);
    expect(wider).not.toBeNull();
    expect(overlaps({ ...wider!, ...card }, items[0]!)).toBe(false);
  });
});
