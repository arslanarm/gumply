import { describe, expect, it } from "vitest";
import { freeSpot } from "../src/board/placement";

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
});
