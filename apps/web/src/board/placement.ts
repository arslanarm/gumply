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

/** The top-left corner for a `want`-sized card: `want`'s own if free, else the nearest free one around it. */
export function freeSpot(want: { x: number; y: number; width: number; height: number }, all: readonly Box[]): { x: number; y: number } {
  const items = all.filter((item) => item.type !== "group");
  if (!hits(want.x, want.y, want.width, want.height, items)) return { x: want.x, y: want.y };
  for (let ring = 1; ring <= RINGS; ring += 1) {
    // The ring's cells, nearest to the wanted spot first.
    const cells: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -ring; i <= ring; i += 1) {
      for (const [dx, dy] of [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ] as const) {
        cells.push({ x: want.x + dx * STEP, y: want.y + dy * STEP, d: Math.hypot(dx, dy) });
      }
    }
    cells.sort((a, b) => a.d - b.d);
    for (const cell of cells) if (!hits(cell.x, cell.y, want.width, want.height, items)) return { x: cell.x, y: cell.y };
  }
  // Crowded everywhere near: at least don't sit exactly on what's there (a cascade offset).
  return { x: want.x + 2 * GAP, y: want.y + 2 * GAP };
}
