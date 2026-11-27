/**
 * #b9425ktw (#fzrwse3y's P3 5): where a new card goes. The spot asked for (the view's centre) if it's free;
 * otherwise the nearest free spot around it, searched ring by ring on a grid, so the card never lands on top of
 * existing items and takes their clicks. Frames (groups) don't count: a card may go inside one.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  type?: string;
}

/** Space kept between the new card and its neighbours. */
const GAP = 16;
/** Grid step of the search, and how many rings out it looks before giving up. */
const STEP = 40;
const RINGS = 30;

function hits(x: number, y: number, width: number, height: number, items: readonly Box[]): boolean {
  return items.some(
    (item) =>
      x < item.x + item.width + GAP && item.x - GAP < x + width && y < item.y + item.height + GAP && item.y - GAP < y + height,
  );
}

/** The search's cells, nearest first by straight-line distance (in grid steps), built once. */
const CELLS: ReadonlyArray<{ dx: number; dy: number }> = (() => {
  const cells: Array<{ dx: number; dy: number; d: number }> = [];
  for (let dx = -RINGS; dx <= RINGS; dx += 1) for (let dy = -RINGS; dy <= RINGS; dy += 1) if (dx || dy) cells.push({ dx, dy, d: Math.hypot(dx, dy) });
  // By distance across the whole square (a ring's corners are farther than the next ring's edges: @opus-editor).
  return cells.sort((a, b) => a.d - b.d);
})();

/**
 * The nearest free top-left corner for a `want`-sized card (`want`'s own if free), or null when there's none. With
 * `within` (the visible part of the board), only spots wholly inside it count.
 */
export function nearestFree(
  want: { x: number; y: number; width: number; height: number },
  all: readonly Box[],
  within?: { x: number; y: number; width: number; height: number },
): { x: number; y: number } | null {
  const items = all.filter((item) => item.type !== "group");
  const inside = (x: number, y: number) =>
    !within || (x >= within.x && y >= within.y && x + want.width <= within.x + within.width && y + want.height <= within.y + within.height);
  if (inside(want.x, want.y) && !hits(want.x, want.y, want.width, want.height, items)) return { x: want.x, y: want.y };
  for (const { dx, dy } of CELLS) {
    const x = want.x + dx * STEP;
    const y = want.y + dy * STEP;
    if (inside(x, y) && !hits(x, y, want.width, want.height, items)) return { x, y };
  }
  return null;
}

/**
 * The top-left corner for a `want`-sized card: the nearest free one (in `within` if given), else a small offset from
 * `want`, so it at least doesn't sit exactly on what's there.
 */
export function freeSpot(
  want: { x: number; y: number; width: number; height: number },
  all: readonly Box[],
  within?: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  return nearestFree(want, all, within) ?? { x: want.x + 2 * GAP, y: want.y + 2 * GAP };
}
